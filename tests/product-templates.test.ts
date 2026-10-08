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
  for (const recipe of [
    'saas',
    'storefront',
    'storefront-react',
    'dashboard',
    'api',
    'monorepo',
  ] as const) {
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
    if (recipe === 'monorepo' || recipe === 'storefront-react') {
      await fs.mkdir(path.join(directory, 'apps/api/node_modules/@forge'), { recursive: true });
      await fs.symlink(
        path.join(directory, 'packages/contracts'),
        path.join(directory, 'apps/api/node_modules/@forge/contracts'),
      );
      if (recipe === 'storefront-react') {
        await fs.symlink(
          path.resolve('node_modules/drizzle-orm'),
          path.join(directory, 'apps/api/node_modules/drizzle-orm'),
        );
      }
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
test('product scaffolds include persistent auth while retaining operational limits', () => {
  for (const recipe of [
    'saas',
    'storefront',
    'storefront-react',
    'dashboard',
    'api',
    'monorepo',
  ] as const) {
    const files = productFiles(recipe, 'demo');
    const source = (suffix: string) =>
      Object.entries(files).find(([file]) => file.endsWith(suffix))?.[1] ?? '';
    assert.match(files['README.md'], /server-side password sessions/);
    assert.match(files['README.md'], /email verification\/recovery/);
    assert.match(source('src/auth.ts'), /scryptSync/);
    assert.match(source('src/auth.ts'), /HttpOnly; SameSite=Strict/);
    if (recipe === 'storefront-react') {
      assert.match(files['apps/api/migrations/0001_initial.sql'], /CREATE TABLE IF NOT EXISTS users/);
    } else {
      assert.match(source('src/persistence.ts'), /CREATE TABLE IF NOT EXISTS users/);
    }
    assert.match(source('src/persistence.test.ts'), /survive reopening/);
    assert.ok(Object.keys(files).some((file) => file.endsWith('domain.test.ts')));
    const manifest = JSON.parse(files['package.json']);
    assert.ok(manifest.scripts.test);
    assert.ok(manifest.scripts.typecheck);
    if (recipe === 'storefront-react') {
      assert.match(files['apps/web/src/components/Catalog.tsx'], /Search products/);
      assert.match(files['apps/web/src/components/CartPanel.tsx'], /Remove /);
      assert.match(files['apps/web/src/components/Catalog.tsx'], /Loading products/);
      assert.match(files['apps/web/src/App.tsx'], /useStore/);
      assert.match(files['apps/api/src/repository.ts'], /database\.orm/);
      assert.match(files['apps/api/src/infrastructure/schema.ts'], /sqliteTable/);
      assert.match(files['apps/api/migrations/0001_initial.sql'], /CREATE TABLE IF NOT EXISTS users/);
      assert.equal(files['apps/api/src/persistence.ts'], undefined);
      assert.match(files['apps/api/package.json'], /drizzle-orm/);
      assert.match(files['apps/api/src/http/response.ts'], /x-content-type-options/);
      assert.equal(files['apps/web/src/persistence.ts'], undefined);
      assert.equal(files['apps/web/src/auth.ts'], undefined);
      assert.match(files['apps/web/src/cart.test.ts'], /cart totals/);
    }
  }
});
