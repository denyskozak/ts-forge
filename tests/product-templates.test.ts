import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { productFiles, scaffoldProduct } from '../electron/product-templates';

test('all product starters run their domain and contract tests from persisted files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-product-tests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const recipe of ['saas', 'storefront', 'dashboard', 'api', 'monorepo'] as const) {
    const directory = path.join(root, recipe);
    await fs.mkdir(directory);
    const receipt = await scaffoldProduct(
      directory,
      recipe,
      `test-${recipe}`,
      AbortSignal.timeout(10000),
    );
    assert.equal(receipt.installed, false);
    const tests = receipt.files
      .filter((file) => /\.test\.ts$/.test(file))
      .map((file) => path.join(directory, file));
    if (recipe === 'monorepo') {
      await fs.mkdir(path.join(directory, 'apps/api/node_modules/@forge'), { recursive: true });
      await fs.symlink(
        path.join(directory, 'packages/contracts'),
        path.join(directory, 'apps/api/node_modules/@forge/contracts'),
      );
    }
    const result = await promisify(execFile)(
      process.execPath,
      [path.resolve('node_modules/tsx/dist/cli.mjs'), '--test', '--test-reporter=tap', ...tests],
      { cwd: directory, env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
    );
    assert.match(result.stdout, /# fail 0/);
    await assert.rejects(
      scaffoldProduct(directory, recipe, 'another', AbortSignal.timeout(1000)),
      /empty workspace/,
    );
  }
});
test('product scaffolds retain explicit production limitations and separate install', () => {
  for (const recipe of ['saas', 'storefront', 'dashboard', 'api', 'monorepo'] as const) {
    const files = productFiles(recipe, 'demo');
    assert.match(files['README.md'], /before deployment|Before production/);
    assert.ok(Object.keys(files).some((file) => file.endsWith('domain.test.ts')));
    const manifest = JSON.parse(files['package.json']);
    assert.ok(manifest.scripts.test);
    assert.ok(manifest.scripts.typecheck);
  }
});
