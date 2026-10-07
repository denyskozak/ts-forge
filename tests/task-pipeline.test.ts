import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointSchema, taskPipelineForPrompt } from '../shared/checkpoint';

test('planner selects task-specific development pipelines', () => {
  assert.deepEqual(taskPipelineForPrompt('Create a new R3F snake game'), {
    kind: 'development',
    phases: ['analysis', 'changes', 'checks', 'preview', 'delivery'],
    instructions:
      'Define runnable behavior, establish or scaffold the project, implement complete source and meaningful tests, install only required dependencies, run checks, then start and exercise the real application.',
  });
  assert.equal(taskPipelineForPrompt('Improve rendering performance').kind, 'improvement');
  assert.equal(taskPipelineForPrompt('Change snake edge collision behavior').kind, 'change');
  assert.deepEqual(taskPipelineForPrompt('Analyze the project architecture').phases, [
    'analysis',
    'delivery',
  ]);
});

test('legacy checkpoints receive a compatible change pipeline', () => {
  const checkpoint = checkpointSchema.parse({
    prompt: 'Change behavior',
    step: 0,
    phase: 'analysis',
    groups: ['core'],
    planned: false,
    resumable: true,
    reason: 'Task running',
    summary: '',
    updatedAt: 1,
  });
  assert.equal(checkpoint.kind, 'change');
  assert.deepEqual(checkpoint.pipeline, ['analysis', 'changes', 'checks', 'preview', 'delivery']);
});
