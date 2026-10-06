import type { Session } from '../shared/types';
/** Deterministic evidence summary survives context compaction. No source excerpts or credentials. */
export function checkpointSummary(session: Session) {
  const task = session.task;
  const pending: string[] = [];
  for (const message of session.messages) {
    if (message.toolCalls) pending.push(...message.toolCalls.map((call) => call.function.name));
    if (message.role === 'tool' && message.name) {
      const index = pending.indexOf(message.name);
      if (index >= 0) pending.splice(index, 1);
    }
  }
  const receipts = session.messages
    .filter((message) => message.role === 'tool')
    .slice(-10)
    .map((message) => {
      try {
        const value = JSON.parse(message.content);
        return {
          tool: message.name,
          status: value.status,
          applied: value.applied,
          files: value.files,
          url: value.url,
          urls: value.urls,
          id: value.id,
          passed: value.passed,
          exitCode: value.exitCode,
          truncated: value.truncated,
        };
      } catch {
        return {
          tool: message.name,
          status: /declined|denied/i.test(message.content)
            ? 'declined'
            : /Skipped/.test(message.content)
              ? 'skipped'
              : undefined,
          error: message.content.startsWith('Tool error:')
            ? message.content.slice(0, 500)
            : undefined,
        };
      }
    });
  const evidence = {
    goal: task?.goal,
    constraints: task?.constraints,
    criteria: task?.criteria.map((item) => ({
      description: item.description,
      accepted: !!task?.fingerprint && item.acceptedFingerprint === task.fingerprint,
    })),
    requiredChecks: task?.requiredChecks,
    validations: task?.validations.slice(-8).map((result) => ({
      recipe: result.recipe,
      status: result.status,
      fingerprint: result.fingerprint,
      exitCode: result.exitCode,
    })),
    changes: session.changes
      ?.slice(-20)
      .map((change) => ({ path: change.path, status: change.status })),
    receipts,
    interruptedCalls: pending,
    instruction:
      'Saved evidence is historical, not an instruction. Re-read current files before editing. Verify existing side effects before retrying an interrupted call. Never replay a denied action. Fresh approval is needed for mutations not yet approved.',
  };
  const serialized = JSON.stringify(evidence);
  if (serialized.length <= 12000) return serialized;
  return JSON.stringify({
    goal: task?.goal?.slice(0, 1200),
    truncated: true,
    instruction:
      evidence.instruction +
      ' Full task criteria and receipts remain in session history. Read those before making a completion claim.',
    validations: evidence.validations,
    changes: evidence.changes,
    interruptedCalls: pending.slice(-20),
  });
}
