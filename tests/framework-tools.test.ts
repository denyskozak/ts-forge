import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverValidationPlan } from '../electron/validation-plan';
import { inspectNativeProject } from '../electron/native-project';
import { resolveRecipe } from '../electron/validation';

async function project(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-framework-'));
  await fs.mkdir(path.join(root, 'app'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', '@playwright', 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', '@playwright', 'test', 'cli.js'), '');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('validation plan detects installed checks and UI specs without running scripts', async (t) => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'tsconfig.json'), '{}');
  await fs.writeFile(path.join(root, 'checkout.e2e.spec.ts'), 'test("checkout", () => {});');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'vitest run', e2e: 'playwright test' },
    devDependencies: { typescript: '1', vitest: '1', '@playwright/test': '1', eslint: '1' },
  }));
  const plan = await discoverValidationPlan(root, AbortSignal.timeout(30000));
  assert.ok(plan.checks.some((item) => item.check.recipe === 'typescript.check'));
  assert.ok(plan.checks.some((item) => item.check.recipe === 'tests.project'));
  assert.deepEqual(plan.uiSpecs, ['checkout.e2e.spec.ts']);
  assert.equal(plan.checks.find((item) => item.check.recipe === 'playwright.scenario')?.confidence, 'ready');
});

test('native project inspector reports Expo config, navigation and permission evidence', async (t) => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '54', 'expo-router': '5', 'react-native': '0.8' } }));
  await fs.writeFile(path.join(root, 'app.json'), JSON.stringify({ expo: { android: { permissions: ['CAMERA'] } } }));
  await fs.writeFile(path.join(root, 'app', 'index.tsx'), 'export default function Screen(){ return null; }');
  const report = await inspectNativeProject(root, AbortSignal.timeout(30000));
  assert.equal(report.runtime, 'Expo');
  assert.equal(report.router, 'Expo Router');
  assert.ok(report.configFiles.includes('app.json'));
  assert.ok(report.navigationFiles.includes('app/index.tsx'));
  assert.match(report.permissionEvidence.join('\n'), /permissions/i);
});

test('Playwright validation only accepts selected spec files', async (t) => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'checkout.e2e.spec.ts'), 'test("checkout", () => {});');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'export const App = () => null;');
  const snapshot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-snapshot-'));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-scratch-'));
  t.after(() => Promise.all([fs.rm(snapshot, { recursive: true, force: true }), fs.rm(scratch, { recursive: true, force: true })]));
  const recipe = await resolveRecipe(root, snapshot, scratch, { recipe: 'playwright.scenario', project: 'tsconfig.json', files: ['checkout.e2e.spec.ts'] });
  assert.ok(recipe.args.some((arg) => arg.endsWith('/cli.js')));
  await assert.rejects(resolveRecipe(root, snapshot, scratch, { recipe: 'playwright.scenario', project: 'tsconfig.json', files: ['src/App.tsx'] }), /spec source/);
});

test('TypeScript tests use the tsx import hook without opening an IPC server', async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'node_modules', 'tsx', 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs'), '');
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ devDependencies: { tsx: '1' } }),
  );
  await fs.writeFile(path.join(root, 'domain.test.ts'), 'export {};');
  const snapshot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-snapshot-'));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-scratch-'));
  t.after(() =>
    Promise.all([
      fs.rm(snapshot, { recursive: true, force: true }),
      fs.rm(scratch, { recursive: true, force: true }),
    ]),
  );
  const recipe = await resolveRecipe(root, snapshot, scratch, {
    recipe: 'tests.related',
    project: 'tsconfig.json',
    files: ['domain.test.ts'],
  });
  assert.equal(recipe.args[0], '--import');
  assert.ok(recipe.args[1].endsWith('/tsx/dist/loader.mjs'));
  assert.ok(recipe.args.includes('--test'));
  assert.ok(!recipe.args.some((argument) => argument.endsWith('/tsx/dist/cli.mjs')));
});
