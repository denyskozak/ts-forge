import { promises as fs } from 'node:fs';
import { rollbackChangeSet, undoChangeSet } from './change-sets';
import { randomUUID } from 'node:crypto';
import type { Change } from '../shared/types';
import type { Store } from './store';
import { applyChange, readText, removeCreatedFile } from './workspace';
export async function commitChange(store: Store, change: Change, runId?: string) {
  if (!change.workspace) throw new Error('Change has no workspace.');
  change.status = 'applying';
  store.journal('write-intent', change, runId);
  await store.save();
  try {
    await applyChange(change.workspace, change.path, change.before, change.after, change.existed);
  } catch (error) {
    change.status = 'failed';
    store.journal('write-failed', { id: change.id, error: String(error) }, runId);
    await store.save();
    throw error;
  }
  // Keep the durable intent recoverable if persistence fails after the rename.
  change.status = 'applied';
  store.journal('write-applied', change, runId);
  await store.save();
}
export async function undoChange(store: Store, id: string) {
  const change = store.value.sessions.flatMap((s) => s.changes ?? []).find((c) => c.id === id);
  if (!change?.workspace || change.status !== 'applied')
    throw new Error('Only an applied change can be undone.');
  if (change.changeSetId) {
    await undoChangeSet(store, change.changeSetId);
    return change;
  }
  store.journal('undo-intent', { id, change }, randomUUID());
  change.status = 'undoing';
  await store.save();
  try {
    if (change.existed === false)
      await removeCreatedFile(change.workspace, change.path, change.after);
    else await applyChange(change.workspace, change.path, change.after, change.before, true);
  } catch (error) {
    change.status = 'applied';
    await store.save();
    throw error;
  }
  change.status = 'undone';
  store.journal('undo-completed', change);
  await store.save();
  return change;
}
export async function recoverInterrupted(store: Store) {
  let dirty = false;
  const run = store.value.activeRun;
  if (run && ['running', 'waiting'].includes(run.status)) {
    run.status = 'interrupted';
    run.label = 'Interrupted by app restart. Inspect changes before continuing.';
    delete run.approval;
    delete run.clarification;
    delete run.stream;
    dirty = true;
    const session = store.value.sessions.find((s) => s.id === run.sessionId);
    session?.messages.push({
      id: randomUUID(),
      role: 'assistant',
      content: run.label,
      time: Date.now(),
      runId: run.id,
    });
  }
  for (const session of store.value.sessions) {
    for (const set of session.changeSets ?? []) {
      if (['applying', 'rolling_back'].includes(set.status)) {
        await rollbackChangeSet(store, set);
        dirty = true;
      } else if (set.status === 'pending') {
        set.status = 'rejected';
        dirty = true;
      }
    }
    if (session.task?.outcome === 'in_progress') {
      session.task.outcome = 'stopped';
      dirty = true;
    }
  }
  for (const session of store.value.sessions)
    for (const change of session.changes ?? []) {
      if (change.status === 'pending') {
        change.status = 'rejected';
        dirty = true;
      }
      if (change.status === 'undoing' && change.workspace) {
        let actual: string | undefined;
        try {
          actual = await readText(change.workspace, change.path);
        } catch {}
        change.status =
          (change.existed === false && actual === undefined) || actual === change.before
            ? 'undone'
            : actual === change.after
              ? 'applied'
              : 'conflict';
        dirty = true;
      }
      if (change.status === 'applying' && change.workspace) {
        let actual: string | undefined;
        try {
          actual = await readText(change.workspace, change.path);
        } catch {}
        change.status =
          actual === change.after ? 'applied' : actual === change.before ? 'failed' : 'conflict';
        dirty = true;
      }
    }
  for (const job of store.value.jobs)
    if (job.status === 'running') {
      job.status = 'interrupted';
      job.endedAt = Date.now();
      job.message = 'App restarted; verify the previous process before starting training.';
      dirty = true;
    }
  if (dirty) {
    store.recovery.push(
      'Interrupted operations were recovered. Applied files were checked against checkpoints.',
    );
    await store.save();
  }
}
// Export includes only Forge data selected by the user; never opens a network connection.
export async function exportSession(store: Store, id: string, destination: string) {
  const session = store.value.sessions.find((s) => s.id === id);
  if (!session) throw new Error('Session not found');
  await fs.writeFile(destination, JSON.stringify(session, null, 2), { mode: 0o600 });
}
