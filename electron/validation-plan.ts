import { readText, scanFiles } from './workspace';
import type { ValidationCheck } from '../shared/task';

type Manifest = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

export async function discoverValidationPlan(root: string, signal: AbortSignal) {
  const files = await scanFiles(root, 10_000, signal);
  let manifest: Manifest = {};
  try {
    manifest = JSON.parse(await readText(root, 'package.json')) as Manifest;
  } catch {}
  const packages = { ...manifest.dependencies, ...manifest.devDependencies };
  const has = (name: string) => Boolean(packages[name]);
  const checks: { check: ValidationCheck; confidence: 'ready' | 'needs-config'; reason: string }[] = [];
  if (files.files.some((file) => /(^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(file)))
    checks.push({ check: { recipe: 'typescript.check', project: 'tsconfig.json', files: [] }, confidence: 'ready', reason: 'tsconfig detected' });
  if (has('vitest') || has('jest'))
    checks.push({ check: { recipe: 'tests.project', project: 'tsconfig.json', files: [] }, confidence: 'ready', reason: has('vitest') ? 'Vitest installed' : 'Jest installed' });
  if (has('eslint'))
    checks.push({ check: { recipe: 'lint.files', project: 'tsconfig.json', files: [] }, confidence: 'needs-config', reason: 'ESLint needs the changed file paths' });
  if (has('prettier'))
    checks.push({ check: { recipe: 'format.check', project: 'tsconfig.json', files: [] }, confidence: 'needs-config', reason: 'Prettier needs the changed file paths' });
  if (has('next'))
    checks.push({ check: { recipe: 'next.build', project: 'tsconfig.json', files: [] }, confidence: 'ready', reason: 'Next.js installed' });
  if (has('expo'))
    checks.push({ check: { recipe: 'expo.doctor', project: 'tsconfig.json', files: [] }, confidence: 'ready', reason: 'Expo installed' });
  const specs = files.files.filter((file) => /(?:^|\/)(?:e2e\/|.*\.(?:e2e|ui|pw)\.(?:test|spec)\.[cm]?[jt]sx?$)/.test(file));
  if (has('@playwright/test'))
    checks.push({
      check: { recipe: 'playwright.scenario', project: 'tsconfig.json', files: specs.slice(0, 8) },
      confidence: specs.length ? 'ready' : 'needs-config',
      reason: specs.length ? `${specs.length} UI scenario file(s) detected` : 'Playwright is installed; add or select a UI spec',
    });
  return {
    scripts: Object.keys(manifest.scripts ?? {}).sort(),
    detectedPackages: ['next', 'expo', 'vitest', 'jest', '@playwright/test', 'eslint', 'prettier'].filter(has),
    checks,
    uiSpecs: specs.slice(0, 40),
    note: 'Recommendations use only installed local tools. Choose checks before editing so the task contract remains stable.',
  };
}
