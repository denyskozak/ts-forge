import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ProductArchitecture, ProductRecipe } from '../shared/types';
import { readText, scanFiles } from './workspace';
import { executableEnvironment, resolveExecutable, terminate } from './executor';

const sourcePattern = /\.(?:[cm]?[jt]sx?|prisma|sql|ya?ml|json)$/;
const destructiveSql =
  /\b(?:drop\s+(?:table|column|index|schema)|truncate|delete\s+from|alter\s+table\b[\s\S]{0,120}\bdrop\b)\b/i;

export const PRODUCT_RECIPES: ProductRecipe[] = [
  {
    id: 'saas',
    name: 'T3 SaaS',
    base: 't3',
    description: 'Next.js App Router, tRPC, database, authentication boundary and background jobs.',
    checks: ['typecheck', 'unit tests', 'migration review', 'browser smoke'],
  },
  {
    id: 'storefront',
    name: 'Storefront',
    base: 'next',
    description:
      'Server-rendered catalog, cart state, checkout boundary, inventory and webhook contracts.',
    checks: ['typecheck', 'contract tests', 'checkout E2E', 'accessibility smoke'],
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    base: 'next',
    description:
      'Authenticated dashboard with server data, tables, filters and role-aware actions.',
    checks: ['typecheck', 'authorization tests', 'browser smoke', 'bundle budget'],
  },
  {
    id: 'api',
    name: 'TypeScript API',
    base: 'api',
    description: 'Hono API with versioned routes, validation, OpenAPI and local contract checks.',
    checks: ['typecheck', 'route tests', 'OpenAPI validation', 'local HTTP smoke'],
  },
  {
    id: 'monorepo',
    name: 'Product monorepo',
    base: 't3',
    description: 'pnpm workspace with web, API and shared contract packages.',
    checks: ['recursive typecheck', 'package tests', 'dependency boundaries', 'browser smoke'],
  },
];

const lineNumber = (source: string, offset: number) => source.slice(0, offset).split('\n').length;

export async function analyzeProductArchitecture(
  root: string,
  signal?: AbortSignal,
): Promise<ProductArchitecture> {
  const scan = await scanFiles(root, 10_000, signal);
  const files = scan.files.filter((file) => sourcePattern.test(file)).slice(0, 2_500);
  const report: ProductArchitecture = {
    detected: [],
    trpc: { routers: [], procedures: [], callers: [] },
    database: { providers: [], schemas: [], models: [], indexes: [], migrations: [] },
    contracts: [],
    migrations: { destructive: [], safe: [] },
    recipes: PRODUCT_RECIPES,
    warnings: [...scan.warnings],
  };
  for (const file of files) {
    signal?.throwIfAborted();
    let source: string;
    try {
      source = await readText(root, file);
    } catch (error) {
      report.warnings.push(`${file}: ${(error as Error).message}`);
      continue;
    }
    if (/\b(?:createTRPCRouter|router)\s*\(\s*\{/.test(source)) {
      report.trpc.routers.push(file);
      report.detected.push('tRPC');
    }
    for (const match of source.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*:\s*((?:public|protected|admin|private)Procedure)\b/g,
    )) {
      report.trpc.procedures.push({
        name: match[1],
        kind: match[2],
        file,
        line: lineNumber(source, match.index ?? 0),
      });
    }
    if (/\b(?:createTRPCReact|createTRPCProxyClient|httpBatchLink)\b/.test(source))
      report.contracts.push({ kind: 'trpc-client', file, detail: 'Typed tRPC client boundary' });
    for (const match of source.matchAll(
      /\b(?:api|trpc)\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\.(useQuery|useMutation|query|mutate|fetch|prefetch)\s*\(/g,
    ))
      report.trpc.callers.push({
        path: match[1],
        operation: match[2],
        file,
        line: lineNumber(source, match.index ?? 0),
      });
    if (/\b(?:pgTable|sqliteTable|mysqlTable)\s*\(/.test(source)) {
      report.detected.push('Drizzle');
      report.database.providers.push('Drizzle');
      report.database.schemas.push(file);
      for (const match of source.matchAll(
        /\b(?:pgTable|sqliteTable|mysqlTable)\s*\(\s*['"]([^'"]+)/g,
      ))
        report.database.models.push({ name: match[1], file });
      for (const match of source.matchAll(/\b(?:index|uniqueIndex)\s*\(\s*['"]([^'"]+)/g))
        report.database.indexes.push({ name: match[1], file });
    }
    if (path.basename(file) === 'schema.prisma') {
      report.detected.push('Prisma');
      report.database.providers.push('Prisma');
      report.database.schemas.push(file);
      for (const match of source.matchAll(/\bmodel\s+([A-Za-z_$][\w$]*)\s*\{/g))
        report.database.models.push({ name: match[1], file });
      for (const match of source.matchAll(/@@(?:index|unique)\s*\(([^\n]+)/g))
        report.database.indexes.push({ name: match[1].trim(), file });
    }
    const normalized = file.replaceAll('\\', '/');
    const migration = /(?:^|\/)migrations?\//i.test(normalized) || /\.sql$/i.test(file);
    if (migration) {
      report.database.migrations.push(file);
      (destructiveSql.test(source) ? report.migrations.destructive : report.migrations.safe).push(
        file,
      );
    }
    if (/openapi|swagger/i.test(path.basename(file)) || /\bopenapi\s*:\s*['"]?3\./i.test(source)) {
      report.detected.push('OpenAPI');
      report.contracts.push({ kind: 'openapi', file, detail: 'OpenAPI document or builder' });
    }
    if (
      /(?:^|\/)(?:app\/api|pages\/api|src\/routes?|server\/routes?)\//.test(normalized) ||
      /\b(?:app|router)\.(?:get|post|put|patch|delete)\s*\(/.test(source)
    )
      report.contracts.push({ kind: 'http-route', file, detail: 'Local HTTP endpoint boundary' });
  }
  report.detected = [...new Set(report.detected)];
  report.trpc.routers = [...new Set(report.trpc.routers)];
  report.database.providers = [...new Set(report.database.providers)];
  report.database.schemas = [...new Set(report.database.schemas)];
  report.database.migrations = [...new Set(report.database.migrations)];
  report.contracts = report.contracts.filter(
    (item, index, all) =>
      all.findIndex((other) => other.kind === item.kind && other.file === item.file) === index,
  );
  if (report.migrations.destructive.length)
    report.warnings.push(
      `${report.migrations.destructive.length} migration file(s) contain destructive SQL and require separate review.`,
    );
  return report;
}

export async function createDisposableSqlite(root: string) {
  const directory = path.join(root, '.forge');
  await fs.mkdir(directory, { recursive: true });
  const database = path.join(directory, 'development.sqlite');
  const handle = await fs.open(database, 'a', 0o600);
  await handle.close();
  return { kind: 'sqlite' as const, database, disposable: true };
}

function postgresName(root: string) {
  return `forge-pg-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`;
}

async function docker(args: string[], signal: AbortSignal, timeoutMs = 120_000) {
  signal.throwIfAborted();
  const executable = await resolveExecutable('docker');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: executableEnvironment(executable),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const cancel = () => terminate(child);
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, timeoutMs);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (code === 0) resolve(output.trim());
      else reject(new Error(output.trim() || `docker exited with ${code}`));
    });
  });
}

export async function startDisposablePostgres(root: string, signal: AbortSignal) {
  const name = postgresName(root);
  const existing = await docker(
    ['inspect', '-f', '{{.State.Running}}', name],
    signal,
    20_000,
  ).catch(() => '');
  if (existing !== 'true')
    await docker(
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        name,
        '--label',
        'dev.forge.disposable=true',
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        '--env',
        'POSTGRES_DB=forge',
        'postgres:17-alpine',
      ],
      signal,
      300_000,
    );
  const mapping = await docker(['port', name, '5432/tcp'], signal, 20_000);
  const port = Number(mapping.match(/:(\d+)\s*$/)?.[1]);
  if (!port) throw new Error(`Docker did not report a PostgreSQL port: ${mapping}`);
  return {
    kind: 'postgres' as const,
    name,
    host: '127.0.0.1',
    port,
    database: 'forge',
    user: 'postgres',
    disposable: true,
  };
}

export async function stopDisposablePostgres(root: string, signal: AbortSignal) {
  const name = postgresName(root);
  await docker(['stop', '--time', '5', name], signal, 30_000);
  return { kind: 'postgres' as const, name, stopped: true };
}
