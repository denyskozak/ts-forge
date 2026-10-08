import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../shared/types';

Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
const { presentToolResult } = await import('../src/components/ToolResult');
const { presentAssistantText } = await import('../src/message-presentation');

const tool = (name: string, content: string): Message => ({
  id: crypto.randomUUID(),
  role: 'tool',
  name,
  content,
  time: Date.now(),
});

test('task receipts become compact plan summaries without protocol identifiers', () => {
  const view = presentToolResult(
    tool(
      'plan_task',
      JSON.stringify({
        runId: 'private-run-id',
        goal: 'Fix sum',
        criteria: [{ id: 'private-criterion-id', description: 'Returns a sum' }],
        requiredChecks: [{ recipe: 'typescript.check' }],
        fingerprint: 'private-fingerprint',
      }),
    ),
  );
  assert.equal(view.title, 'Task planned');
  assert.equal(view.summary, 'Fix sum');
  assert.deepEqual(view.metrics, ['1 criteria', '1 checks']);
  assert.doesNotMatch(
    JSON.stringify(view),
    /private-run-id|private-criterion-id|private-fingerprint/,
  );
});

test('file, validation and error receipts use purpose-specific presentations', () => {
  const file = presentToolResult(
    tool(
      'read_file',
      JSON.stringify({ path: 'src/App.tsx', totalLines: 42, totalCharacters: 1200 }),
    ),
  );
  assert.equal(file.title, 'File read');
  assert.deepEqual(file.paths, ['src/App.tsx']);
  assert.deepEqual(file.metrics, ['42 lines', '1200 characters']);

  const check = presentToolResult(
    tool(
      'run_validation',
      JSON.stringify({
        recipe: 'typescript.check',
        status: 'passed',
        durationMs: 81,
        output: 'ok',
      }),
    ),
  );
  assert.equal(check.title, 'Check passed');
  assert.equal(check.tone, 'success');
  assert.equal(check.log, 'ok');

  const error = presentToolResult(tool('replace_text', 'Tool error: Fragment was not found.'));
  assert.equal(error.title, 'Replace Text failed');
  const schemaError = presentToolResult(
    tool(
      'apply_changeset',
      'Tool error: [{"path":["edits"],"message":"Expected at least one file edit"}]',
    ),
  );
  assert.equal(schemaError.summary, 'edits: Expected at least one file edit');
  assert.doesNotMatch(schemaError.summary ?? '', /[{}\[\]"]/);
  assert.equal(error.summary, 'Fragment was not found.');
  assert.equal(error.tone, 'danger');
});

test('assistant presentation hides source blocks and internal task receipts', () => {
  const content = [
    'Created the game in src/App.tsx.',
    '```tsx\nexport function App() { return <Canvas /> }\n```',
    'Final answer:',
    JSON.stringify({ runId: 'run-1', appliedChanges: 0, outcome: 'success' }),
  ].join('\n\n');
  assert.equal(presentAssistantText(content), 'Created the game in src/App.tsx.');
  assert.equal(
    presentAssistantText('```ts\nexport const game = true;\n```'),
    'Implementation written directly to the project.',
  );
  assert.equal(
    presentAssistantText(JSON.stringify({ name: 'apply_changeset', parameters: { changes: [] } })),
    '',
  );
});

test('assistant presentation hides a truncated printed tool envelope', () => {
  assert.equal(
    presentAssistantText(
      '{"name":"plan_task","parameters":{"goal":"Wrap snake at edges","criteria":[]}',
    ),
    '',
  );
});

test('package script discovery is presented as a read-only project result', () => {
  const view = presentToolResult(
    tool(
      'package_scripts',
      JSON.stringify({ name: 'agent-test', scripts: { dev: 'vite', build: 'vite build' } }),
    ),
  );
  assert.equal(view.title, 'Project scripts found');
  assert.equal(view.summary, 'agent-test');
  assert.deepEqual(view.metrics, ['2 scripts']);
  assert.equal(view.tone, 'success');
});

test('R3F runtime, performance, visual and scenario receipts use compact UI cards', () => {
  const runtime = presentToolResult(
    tool(
      'r3f_runtime_snapshot',
      JSON.stringify({
        status: 'captured',
        contexts: [{}],
        drawCalls: 42,
        triangles: 128,
        liveResources: 9,
      }),
    ),
  );
  assert.equal(runtime.title, 'R3F runtime inspected');
  assert.deepEqual(runtime.metrics, ['1 context', '42 draws', '128 triangles', '9 live resources']);

  const profile = presentToolResult(
    tool(
      'r3f_performance_profile',
      JSON.stringify({
        status: 'captured',
        durationMs: 2000,
        averageFps: 59.8,
        p95FrameMs: 18.2,
        slowFrames: 1,
        drawCalls: 300,
      }),
    ),
  );
  assert.equal(profile.title, 'R3F performance sampled');
  assert.deepEqual(profile.metrics, ['59.8 FPS', '18.2 ms p95', '1 slow frames', '300 draws']);

  const visual = presentToolResult(
    tool(
      'visual_assert',
      JSON.stringify({
        passed: true,
        status: 'passed',
        expectation: 'Canvas is visible',
        screenshot: '/private/preview.png',
        width: 640,
        height: 480,
        colorVariation: 0.16,
      }),
    ),
  );
  assert.equal(visual.title, 'Visual check passed');
  assert.equal(visual.summary, 'Canvas is visible');
  assert.deepEqual(visual.metrics, ['640 × 480', '0.16 variation']);

  const scenario = presentToolResult(
    tool(
      'browser_scenario',
      JSON.stringify({
        passed: true,
        status: 'passed',
        name: 'snake smoke',
        completedSteps: 4,
        totalSteps: 4,
        durationMs: 700,
        saved: true,
      }),
    ),
  );
  assert.equal(scenario.title, 'Browser scenario passed');
  assert.deepEqual(scenario.metrics, ['4/4 steps', '700 ms', 'Saved']);
});
