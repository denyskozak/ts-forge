import test from 'node:test';
import assert from 'node:assert/strict';
import { initialRunView, runViewReducer } from '../src/state/run-view';
import type { Message, Session } from '../shared/types';
const message: Message = { id: 'm', role: 'assistant', content: 'Done', time: 1 };
const session: Session = {
  id: 's',
  title: 'task',
  workspace: '/fixture',
  updatedAt: 1,
  messages: [message],
  changes: [],
};
test('final session is authoritative and clears stream and approval together', () => {
  const before = {
    ...initialRunView,
    busy: true,
    stream: 'partial',
    approval: { id: 'a', kind: 'typecheck' as const, title: 'Check' },
    clarification: {
      id: 'q',
      question: 'Choose?',
      reason: 'The choice changes behavior.',
      options: [
        { id: 'one', label: 'One' },
        { id: 'two', label: 'Two' },
      ],
    },
  };
  Object.freeze(before);
  const after = runViewReducer(before, { type: 'done', session });
  assert.equal(after.busy, false);
  assert.equal(after.stream, '');
  assert.equal(after.approval, undefined);
  assert.equal(after.clarification, undefined);
  assert.deepEqual(after.messages, [message]);
  assert.equal(before.stream, 'partial');
});
test('clarification events pause the view until an answer is submitted', () => {
  const clarification = {
    id: 'q',
    question: 'Choose a target?',
    reason: 'The target changes the public API.',
    options: [
      { id: 'modern', label: 'Modern' },
      { id: 'legacy', label: 'Legacy' },
    ],
  };
  const waiting = runViewReducer(
    { ...initialRunView, busy: true },
    { type: 'clarification', clarification },
  );
  assert.equal(waiting.clarification, clarification);
  const answered = runViewReducer(waiting, { type: 'clarification-answered' });
  assert.equal(answered.clarification, undefined);
  assert.equal(answered.busy, true);
});
test('hydration overlap does not duplicate messages and tokens preserve history reference', () => {
  const state = { ...initialRunView, messages: [message] };
  const duplicate = runViewReducer(state, { type: 'message', message });
  assert.equal(duplicate.messages.length, 1);
  const streamed = runViewReducer(state, { type: 'token', text: 'next' });
  assert.equal(streamed.messages, state.messages);
  assert.equal(state.stream, '');
  assert.equal(streamed.stream, 'next');
});
test('session switch is blocked during a run and resets review state when idle', () => {
  const active = { ...initialRunView, busy: true };
  assert.equal(runViewReducer(active, { type: 'select', session }), active);
  const selected = runViewReducer(initialRunView, { type: 'select', session });
  assert.equal(selected.sessionId, 's');
  assert.equal(selected.messages, session.messages);
  assert.deepEqual(runViewReducer(selected, { type: 'select' }), {
    ...initialRunView,
    sessionId: undefined,
  });
});

test('project-map formatting ranks relevance without changing cached entries', async () => {
  const { renderMap } = await import('../shared/project-map');
  const entries = Array.from({ length: 150 }, (_, index) =>
    Object.freeze({
      path: `source-${index}.ts`,
      hash: 'x',
      bytes: 100,
      lines: 10,
      symbols: [
        { name: index === 149 ? 'ImportantTarget' : 'other', line: 2, kind: 'FunctionDeclaration' },
      ],
      imports: [],
    }),
  );
  const map = { entries, complete: true, files: 150, format: 'json' as const, warnings: [] };
  const original = JSON.stringify(map);
  Object.freeze(entries);
  const result = renderMap(map, 'ImportantTarget', 1200);
  assert.ok(result.length <= 1200);
  const parsed = JSON.parse(result);
  assert.equal(parsed.entries[0].path, 'source-149.ts');
  assert.equal(parsed.selectionComplete, false);
  assert.equal(JSON.stringify(map), original);
});
