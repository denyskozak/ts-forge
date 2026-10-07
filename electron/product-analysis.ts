import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ProductArchitecture, ProductRecipe } from '../shared/types';
import { readText, scanFiles } from './workspace';
import { executableEnvironment, resolveExecutable, terminate } from './executor';
import { createSqliteSandbox, inspectMigrationSql } from './database-sandbox';

const sourcePattern = /\.(?:[cm]?[jt]sx?|prisma|sql|ya?ml|json)$/;
const destructiveSql =
  /\b(?:drop\s+(?:table|column|index|schema)|truncate|delete\s+from|alter\s+table\b[\s\S]{0,120}\b(?:drop|type|constraint|not\s+null)\b)\b/i;

export const PRODUCT_RECIPES: ProductRecipe[] = [
  {
    id: 'saas',
    name: 'SaaS project starter',
    base: 'next',
    description:
      'Next.js workflow with SQLite persistence, scrypt password sessions and tested owner isolation.',
    checks: ['typecheck', 'identity and persistence tests', 'build', 'browser persistence smoke'],
  },
  {
    id: 'storefront',
    name: 'Storefront',
    base: 'next',
    description:
      'Persistent catalog/cart, password sessions and integer-price calculations. Checkout fails explicitly until a payment provider is configured.',
    checks: ['typecheck', 'identity and cart persistence tests', 'build', 'cart browser flow'],
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    base: 'next',
    description:
      'Filterable persistent catalog with password sessions and tested authorization boundaries.',
    checks: ['typecheck', 'identity and authorization tests', 'build', 'filter browser flow'],
  },
  {
    id: 'api',
    name: 'TypeScript API',
    base: 'api',
    description:
      'Node TypeScript API with SQLite identity/data, owner-scoped routes, input validation, OpenAPI and contract tests.',
    checks: ['typecheck', 'auth and route tests', 'OpenAPI validation', 'local HTTP smoke'],
  },
  {
    id: 'monorepo',
    name: 'Product monorepo',
    base: 'react',
    description:
      'pnpm workspace with a web client, persistent authenticated API and shared contract package.',
    checks: [
      'recursive typecheck',
      'identity and package tests',
      'dependency boundaries',
      'browser smoke',
    ],
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
    if (
      /\bcreateTRPCRouter\s*\(\s*\{/.test(source) ||
      (/from\s+['"][^'"]*trpc[^'"]*['"]/.test(source) && /\brouter\s*\(\s*\{/.test(source))
    ) {
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
      if (inspectMigrationSql(source).requiresReview)
        report.warnings.push(
          `${file}: ${inspectMigrationSql(source).risks.join('; ')}. Dry-run against disposable representative data.`,
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
  if (report.database.migrations.length)
    report.warnings.push(
      'The migrations.safe list means no obvious destructive tokens were detected. It is not proof of compatibility; rehearse migrations against representative disposable data.',
    );
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
  return createSqliteSandbox(root);
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
  if (existing === 'true') await assertPostgresOwnership(root, signal);
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
  const deadline = Date.now() + 30_000;
  while (true) {
    signal.throwIfAborted();
    try {
      await docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'forge'], signal, 5_000);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('Disposable PostgreSQL did not become ready.');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
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
  await assertPostgresOwnership(root, signal);
  await docker(['stop', '--time', '5', name], signal, 30_000);
  return { kind: 'postgres' as const, name, stopped: true };
}

async function assertPostgresOwnership(root: string, signal: AbortSignal) {
  const label = await docker(
    ['inspect', '-f', '{{index .Config.Labels "dev.forge.disposable"}}', postgresName(root)],
    signal,
    10_000,
  );
  if (label !== 'true') throw new Error('Container is not a Forge disposable target.');
}

export async function migratePostgres(
  root: string,
  files: string[],
  dryRun: boolean,
  signal: AbortSignal,
) {
  await assertPostgresOwnership(root, signal);
  const migrations = [];
  for (const file of files) {
    if (!/\.sql$/i.test(file)) throw new Error('Select explicit SQL files.');
    const sql = await readText(root, file);
    if (
      /\\|\b(?:COPY|CREATE\s+(?:EXTENSION|DATABASE|ROLE|USER)|ALTER\s+(?:SYSTEM|ROLE|USER)|BEGIN|COMMIT|ROLLBACK|END|DO|FUNCTION|PROCEDURE)\b/i.test(
        sql,
      )
    )
      throw new Error(
        'Migration contains unsupported server, transaction or executable operations.',
      );
    migrations.push({ file, sql, ...inspectMigrationSql(sql) });
  }
  const sql = `BEGIN; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; ${migrations.map((item) => item.sql).join('\n')}\n${dryRun ? 'ROLLBACK' : 'COMMIT'};`;
  const output = await docker(
    [
      'exec',
      postgresName(root),
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'forge',
      '-c',
      sql,
    ],
    signal,
    30_000,
  );
  return {
    kind: 'postgres',
    dryRun,
    applied: !dryRun,
    status: 'passed',
    files: migrations.map(({ sql: _sql, ...item }) => item),
    output,
  };
}
