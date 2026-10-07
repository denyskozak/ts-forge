/** Executes bundled starters in temporary directories; downloads dependencies only for these fixtures. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { scaffoldProduct } from '../electron/product-templates';
import { resolveExecutable } from '../electron/executor';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-starters-e2e-'));
const report: { recipe: string; passed: boolean; checks: string[]; error?: string }[] = [];
const pnpm = await resolveExecutable('pnpm');
const output = path.resolve('.forge-test-results/product-starters.json');
const recipes = ['api', 'saas', 'storefront', 'dashboard', 'monorepo'] as const;
const selected = process.env.FORGE_PRODUCT_RECIPES?.split(',').map((item) => item.trim());
if (selected?.some((recipe) => !recipes.includes(recipe as (typeof recipes)[number])))
  throw new Error('FORGE_PRODUCT_RECIPES contains an unknown starter.');
await fs.mkdir(path.dirname(output), { recursive: true });
try {
  for (const recipe of recipes.filter((item) => !selected || selected.includes(item))) {
    const entry = {
      recipe,
      passed: false,
      checks: [] as string[],
      error: undefined as string | undefined,
    };
    report.push(entry);
    try {
      const cwd = path.join(root, recipe);
      await fs.mkdir(cwd);
      await scaffoldProduct(cwd, recipe, `forge-${recipe}`, AbortSignal.timeout(30000));
      console.log(
        `${recipe}: install, tests, typecheck, build${recipe === 'api' ? '' : ', browser E2E'}`,
      );
      const listener = createServer();
      listener.listen(0, '127.0.0.1');
      await once(listener, 'listening');
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      const env = { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1', PORT: String(port) };
      for (const args of [
        ['install', '--ignore-scripts', '--frozen-lockfile=false'],
        ['test'],
        ['typecheck'],
        ['build'],
        ...(recipe === 'api' ? [] : [['test:e2e']]),
      ]) {
        try {
          await promisify(execFile)(pnpm, args, {
            cwd,
            env,
            timeout: 180000,
            maxBuffer: 4_000_000,
          });
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          throw new Error(
            `${args.join(' ')}: ${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
          );
        }
        entry.checks.push(args[0]);
        console.log(`${recipe}: ${args[0]} passed`);
      }
      entry.passed = true;
    } catch (error) {
      entry.error = String(error);
      console.error(`${recipe}: ${entry.error}`);
    }
    await fs.writeFile(output, JSON.stringify(report, null, 2));
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
if (report.some((entry) => !entry.passed)) process.exitCode = 1;
console.log(`Starter receipts: ${output}`);
