import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Change, Session } from '../shared/types';
import type { ChangeSet, ImpactReport } from '../shared/task';
import type { Store } from './store';
import { applyChange, readText, removeCreatedFile, safePath } from './workspace';
import { invalidateAnalysis } from './language-tools';
async function content(root: string, file: string): Promise<string | undefined> {
  try {
    return await readText(root, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
export function createChangeSet(
  session: Session,
  runId: string,
  changes: Change[],
  rationale: string,
  impact?: ImpactReport,
): ChangeSet {
  if (!changes.length || changes.length > 40)
    throw new Error('A changeset must contain 1–40 files.');
  if (new Set(changes.map((c) => path.normalize(c.path))).size !== changes.length)
    throw new Error('Duplicate file in changeset. Combine edits per file.');
  if (changes.some((change) => Buffer.byteLength(change.after, 'utf8') > 200_000))
    throw new Error('Changed files must not exceed 200 KB so they remain safely reversible.');
  const set: ChangeSet = {
    id: randomUUID(),
    runId,
    sessionId: session.id,
    workspace: session.workspace,
    changeIds: changes.map((c) => c.id),
    rationale,
    impact,
    status: 'pending',
    createdAt: Date.now(),
  };
  for (const change of changes) change.changeSetId = set.id;
  (session.changes ??= []).push(...changes);
  (session.changeSets ??= []).push(set);
  return set;
}
function members(store: Store, set: ChangeSet) {
  const session = store.value.sessions.find((s) => s.id === set.sessionId);
  const changes = set.changeIds.map((id) => session?.changes?.find((c) => c.id === id));
  if (!changes.length || changes.some((c) => !c || c.workspace !== set.workspace))
    throw new Error('Invalid changeset members.');
  return changes as Change[];
}
async function preflight(changes: Change[], after: boolean) {
  for (const change of changes) {
    await safePath(change.workspace!, change.path, true);
    const actual = await content(change.workspace!, change.path);
    const expected = after ? change.after : change.existed ? change.before : undefined;
    if (actual !== expected)
      throw new Error(`Stale version: ${change.path}. No files were changed.`);
  }
}
/** Recovery journal makes interrupted multi-file application reversible; filesystem readers may see intermediate renames. */
export async function rollbackChangeSet(store: Store, set: ChangeSet) {
  const changes = members(store, set);
  set.status = 'rolling_back';
  await store.save();
  let conflict = false;
  for (const change of [...changes].reverse()) {
    try {
      const actual = await content(set.workspace, change.path);
      if (actual === (change.existed ? change.before : undefined)) {
        change.status = 'undone';
        continue;
      }
      if (actual !== change.after) {
        change.status = 'conflict';
        conflict = true;
        continue;
      }
      if (change.existed)
        await applyChange(set.workspace, change.path, change.after, change.before, true);
      else await removeCreatedFile(set.workspace, change.path, change.after);
      change.status = 'undone';
    } catch {
      change.status = 'conflict';
      conflict = true;
    }
    await store.save();
  }
  set.status = conflict ? 'conflict' : 'rolled_back';
  invalidateAnalysis(set.workspace);
  store.journal('changeset-rollback', { id: set.id, status: set.status }, set.runId);
  await store.save();
}
export async function applyChangeSet(
  store: Store,
  set: ChangeSet,
  signal: AbortSignal,
  afterWrite?: (index: number) => Promise<void>,
) {
  if (set.status !== 'pending') throw new Error('Changeset is no longer pending.');
  const changes = members(store, set);
  signal.throwIfAborted();
  await preflight(changes, false);
  set.status = 'applying';
  changes.forEach((change) => {
    change.status = 'applying';
  });
  store.journal('changeset-intent', { id: set.id, files: set.changeIds }, set.runId);
  await store.save();
  try {
    for (const [index, change] of changes.entries()) {
      signal.throwIfAborted();
      await applyChange(set.workspace, change.path, change.before, change.after, change.existed);
      change.status = 'applied';
      await store.save();
      await afterWrite?.(index);
    }
    signal.throwIfAborted();
    set.status = 'applied';
    store.journal('changeset-applied', { id: set.id }, set.runId);
    await store.save();
  } catch (error) {
    await rollbackChangeSet(store, set);
    throw error;
  } finally {
    invalidateAnalysis(set.workspace);
  }
}
export async function undoChangeSet(store: Store, id: string) {
  const session = store.value.sessions.find((s) => s.changeSets?.some((set) => set.id === id));
  const set = session?.changeSets?.find((set) => set.id === id);
  if (!session || !set || set.status !== 'applied')
    throw new Error('Only an applied changeset can be undone.');
  await preflight(members(store, set), true);
  await rollbackChangeSet(store, set);
  if (session.task) {
    session.task.outcome = 'completed_unverified';
    session.task.criteria.forEach((c) => {
      delete c.acceptedFingerprint;
    });
  }
  await store.save();
  return session;
}
