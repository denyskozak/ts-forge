import test from 'node:test';
import assert from 'node:assert/strict';
import { livePreflight, checkSumFixture } from '../scripts/live-support';
import type { LocalModel } from '../shared/types';
const model = (name: string, size: number, supportsTools = true): LocalModel => ({
  name,
  size,
  supportsTools,
  family: 'fixture',
  parameters: '1B',
  quantization: 'Q4',
});
test('live preflight rejects nonlocal endpoints without network access', async () => {
  let called = false;
  await assert.rejects(
    livePreflight('https://example.com', undefined, {
      models: async () => {
        called = true;
        return [];
      },
      verifyLocalModel: async () => {},
    }),
    /local HTTP/,
  );
  assert.equal(called, false);
});
test('offline Ollama is skipped, but server and configuration errors remain failures', async () => {
  const offline = await livePreflight(undefined, undefined, {
    models: async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
    verifyLocalModel: async () => {},
  });
  assert.equal(offline.ready, false);
  await assert.rejects(
    livePreflight(undefined, undefined, {
      models: async () => {
        throw new Error('Ollama returned 500');
      },
      verifyLocalModel: async () => {},
    }),
    /500/,
  );
  await assert.rejects(
    livePreflight(undefined, undefined, {
      models: async () => [],
      verifyLocalModel: async () => {},
    }),
    /no local tool model/,
  );
});
test('live preflight respects explicit model and verifies local tool capability', async () => {
  let verified = '';
  const dependencies = {
    models: async () => [model('small', 1), model('larger', 5), model('translation', 9, false)],
    verifyLocalModel: async (_endpoint: string, name: string) => {
      verified = name;
    },
  };
  const automatic = await livePreflight(undefined, undefined, dependencies);
  assert.ok(automatic.ready);
  assert.equal(automatic.model.name, 'larger');
  assert.equal(verified, 'larger');
  const explicit = await livePreflight(undefined, 'small', dependencies);
  assert.ok(explicit.ready);
  assert.equal(explicit.model.name, 'small');
  await assert.rejects(livePreflight(undefined, 'translation', dependencies), /not found/);
  await assert.rejects(livePreflight(undefined, 'missing', dependencies), /not found/);
});

test(
  'live behavioral oracle accepts a correct implementation and rejects wrong output or early exit',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-live-oracle-'));
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const filename = path.join(project, 'task.ts');
    await fs.writeFile(
      filename,
      'export function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }',
    );
    assert.equal((await checkSumFixture(project, path.join(root, 'correct'))).exitCode, 0);
    await fs.writeFile(
      filename,
      'export function sum(values: number[]): number { return values.length; }',
    );
    await assert.rejects(checkSumFixture(project, path.join(root, 'wrong')));
    await fs.writeFile(
      filename,
      'declare const process: { exit(code: number): never }; process.exit(0); export function sum(values: number[]): number { return 0; }',
    );
    await assert.rejects(
      checkSumFixture(project, path.join(root, 'exit')),
      /did not reach completion/,
    );
  },
);
