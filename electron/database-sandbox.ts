import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readText } from './workspace';
import { captureWorkspace } from './validation';
import { executeResult, resolveExecutable } from './executor';

const targets = new Map<string, { kind: 'sqlite'; database: string; disposable: true }>();
async function directory(root: string) {
  const base = path.join(await fs.realpath(root), '.forge');
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(base)).isSymbolicLink())
    throw new Error('Sandbox directory cannot be a symbolic link.');
  const target = path.join(base, 'databases');
  await fs.mkdir(target, { mode: 0o700, recursive: true });
  if ((await fs.lstat(target)).isSymbolicLink())
    throw new Error('Sandbox database directory cannot be a symbolic link.');
  return target;
}
export async function createSqliteSandbox(root: string) {
  const database = path.join(await directory(root), `${randomUUID()}.sqlite`);
  const handle = await fs.open(database, 'wx', 0o600);
  await handle.close();
  const db = new DatabaseSync(database);
  db.exec('PRAGMA user_version=1;');
  db.close();
  const target = { kind: 'sqlite' as const, database, disposable: true as const };
  targets.set(root, target);
  return { ...target, databaseUrl: `file:${database}` };
}
export function databaseStatus(root: string) {
  const target = targets.get(root);
  return target
    ? { ...target, databaseUrl: `file:${target.database}`, ready: true }
    : {
        ready: false,
        note: 'Create a fresh disposable SQLite target. Targets are never inferred from project environment files.',
      };
}
async function ownedTarget(root: string) {
  const target = targets.get(root);
  if (!target) throw new Error('Create a disposable SQLite database first.');
  const base = await directory(root);
  if (path.dirname(target.database) !== base || (await fs.lstat(target.database)).isSymbolicLink())
    throw new Error('Database target ownership check failed.');
  return target;
}
export function inspectMigrationSql(sql: string) {
  const normalized = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  const risks: string[] = [];
  if (/\b(?:DROP|TRUNCATE|DELETE|REPLACE)\b/i.test(normalized))
    risks.push('Potential data removal or replacement');
  if (/\bALTER\b[\s\S]*\b(?:TYPE|NOT\s+NULL|CONSTRAINT|RENAME)\b/i.test(normalized))
    risks.push('Compatibility or constraint change');
  if (/\b(?:UNIQUE|CHECK|REFERENCES)\b/i.test(normalized))
    risks.push('New constraints may reject existing data');
  return {
    risks,
    requiresReview: risks.length > 0,
    note: 'Conservative static hints; only execution against representative disposable data checks SQL validity.',
  };
}
export async function migrateSqlite(
  root: string,
  files: string[],
  dryRun: boolean,
  signal: AbortSignal,
) {
  const target = await ownedTarget(root);
  const sqls = [];
  for (const file of files) {
    if (!/\.sql$/i.test(file)) throw new Error('Select explicit SQL migration files.');
    const sql = await readText(root, file);
    // Even quoted occurrences are rejected conservatively: these operations can escape a disposable DB or alter transaction control.
    if (
      /\b(?:ATTACH|DETACH|PRAGMA|VACUUM|load_extension|BEGIN|COMMIT|ROLLBACK|END|RECURSIVE)\b/i.test(
        sql,
      )
    )
      throw new Error(
        'Migration contains unsupported connection, transaction or external-file operations.',
      );
    sqls.push({ file, sql, ...inspectMigrationSql(sql) });
  }
  const scratch = await fs.mkdtemp(path.join(await directory(root), 'migration-'));
  const database = path.join(scratch, 'candidate.sqlite');
  await fs.copyFile(target.database, database);
  await fs.chmod(database, 0o600);
  const runner = path.join(scratch, 'migrate.cjs');
  await fs.writeFile(
    runner,
    `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(database)}); const schema = () => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(); const before = schema(); try { db.exec('BEGIN IMMEDIATE'); for (const sql of ${JSON.stringify(sqls.map((item) => item.sql))}) db.exec(sql); const after = schema(); const integrity = db.prepare('PRAGMA integrity_check').get(); db.exec('COMMIT'); console.log(JSON.stringify({before, after, integrity})); } catch (error) { try { db.exec('ROLLBACK'); } catch {} console.error(error.message); process.exitCode=1; } finally { db.close(); }`,
  );
  try {
    const result = await executeResult(
      process.execPath,
      [runner],
      scratch,
      signal,
      [scratch, path.resolve(path.dirname(process.execPath), '..')],
      [scratch],
      { ELECTRON_RUN_AS_NODE: '1', HOME: scratch, TMPDIR: scratch },
    );
    if (result.exitCode === 0 && !result.cancelled && !result.timedOut && !dryRun)
      await fs.copyFile(database, target.database);
    return {
      kind: 'sqlite',
      dryRun,
      target: target.database,
      files: sqls.map(({ sql: _sql, ...item }) => item),
      status: result.exitCode === 0 && !result.cancelled && !result.timedOut ? 'passed' : 'failed',
      applied: !dryRun && result.exitCode === 0 && !result.cancelled && !result.timedOut,
      ...result,
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
export async function seedSqlite(root: string, script: string, signal: AbortSignal) {
  const target = await ownedTarget(root);
  const captured = await captureWorkspace(root, signal);
  const scratch = await fs.mkdtemp(path.join(await directory(root), 'seed-'));
  const project = path.join(scratch, 'project');
  await fs.mkdir(project);
  try {
    for (const file of captured.files) {
      const dest = path.join(project, file.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.content);
    }
    const modules = await fs.realpath(path.join(root, 'node_modules'));
    if (modules !== path.join(await fs.realpath(root), 'node_modules'))
      throw new Error('External dependencies directory is not supported.');
    await fs.symlink(modules, path.join(project, 'node_modules'));
    const database = path.join(scratch, 'seed.sqlite');
    await fs.copyFile(target.database, database);
    const manifest = JSON.parse(await readText(root, 'package.json'));
    const node = await resolveExecutable('node');
    if (typeof manifest.scripts?.[script] !== 'string') throw new Error('Seed script not found.');
    // Shell is intentional for the reviewed package script, inside a network-denied scratch sandbox with no project secrets.
    const result = await executeResult(
      '/bin/sh',
      ['-c', manifest.scripts[script]],
      project,
      signal,
      [scratch, modules, path.dirname(node)],
      [scratch],
      {
        DATABASE_URL: `file:${database}`,
        FORGE_DISPOSABLE_DATABASE: '1',
        HOME: scratch,
        TMPDIR: scratch,
        PATH: `${path.join(modules, '.bin')}:${path.dirname(node)}:/usr/bin:/bin:/opt/homebrew/bin`,
      },
    );
    if (result.exitCode === 0 && !result.cancelled && !result.timedOut)
      await fs.copyFile(database, target.database);
    return {
      target: target.database,
      script,
      network: false,
      secrets: false,
      status: result.exitCode === 0 && !result.cancelled && !result.timedOut ? 'passed' : 'failed',
      ...result,
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
