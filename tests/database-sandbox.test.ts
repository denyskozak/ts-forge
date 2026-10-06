import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createSqliteSandbox,
  databaseStatus,
  migrateSqlite,
  seedSqlite,
} from '../electron/database-sandbox';

test('disposable migrations dry-run, apply and fail atomically without modifying production data', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS execution sandbox required');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-data-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = await createSqliteSandbox(root);
  let db = new DatabaseSync(target.database);
  db.exec(
    "CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO products VALUES (1, 'kept');",
  );
  db.close();
  await fs.writeFile(
    path.join(root, 'migration.sql'),
    'ALTER TABLE products ADD COLUMN stock INTEGER DEFAULT 0;',
  );
  await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=file:production.sqlite');
  const production = path.join(root, 'production.sqlite');
  await fs.writeFile(production, 'PRODUCTION SENTINEL');
  const dry = await migrateSqlite(root, ['migration.sql'], true, AbortSignal.timeout(10000));
  assert.equal(dry.status, 'passed');
  assert.equal(dry.applied, false);
  db = new DatabaseSync(target.database);
  assert.equal(db.prepare('PRAGMA table_info(products)').all().length, 2);
  db.close();
  const applied = await migrateSqlite(root, ['migration.sql'], false, AbortSignal.timeout(10000));
  assert.equal(applied.applied, true);
  db = new DatabaseSync(target.database);
  assert.equal(db.prepare('PRAGMA table_info(products)').all().length, 3);
  assert.equal(db.prepare('SELECT name FROM products').get()?.name, 'kept');
  db.close();
  await fs.writeFile(
    path.join(root, 'bad.sql'),
    'CREATE TABLE transient (id INTEGER); INSERT INTO missing VALUES(1);',
  );
  const failed = await migrateSqlite(root, ['bad.sql'], false, AbortSignal.timeout(10000));
  assert.equal(failed.status, 'failed');
  db = new DatabaseSync(target.database);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='transient'").get()?.n,
    0,
  );
  db.close();
  await fs.writeFile(
    path.join(root, 'escape.sql'),
    "ATTACH DATABASE '/tmp/production' AS external;",
  );
  await assert.rejects(
    migrateSqlite(root, ['escape.sql'], true, AbortSignal.timeout(10000)),
    /unsupported/,
  );
  assert.equal(await fs.readFile(production, 'utf8'), 'PRODUCTION SENTINEL');
  assert.equal(databaseStatus(root).ready, true);
});
test('seed runs against disposable URL in a secret-free network-denied copy', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS execution sandbox required');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-seed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = await createSqliteSandbox(root);
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(
    path.join(root, '.env'),
    'DATABASE_URL=file:production.sqlite\nPASSWORD=secret',
  );
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { seed: 'node seed.cjs' } }),
  );
  await fs.writeFile(
    path.join(root, 'seed.cjs'),
    `const fs = require('node:fs'); if(fs.existsSync('.env')) throw Error('secret copied'); if (!process.env.FORGE_DISPOSABLE_DATABASE) throw Error('target missing'); const {DatabaseSync} = require('node:sqlite'); const db = new DatabaseSync(process.env.DATABASE_URL.slice(5)); db.exec("CREATE TABLE seeded(id INTEGER); INSERT INTO seeded VALUES(1)"); db.close();`,
  );
  const result = await seedSqlite(root, 'seed', AbortSignal.timeout(10000));
  assert.equal(result.status, 'passed', result.output);
  const db = new DatabaseSync(target.database);
  assert.equal(db.prepare('SELECT count(*) AS n FROM seeded').get()?.n, 1);
  db.close();
  assert.match(await fs.readFile(path.join(root, '.env'), 'utf8'), /production/);
});
test('sandbox directory symlinks cannot redirect database creation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-data-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-data-outside-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.symlink(outside, path.join(root, '.forge'));
  await assert.rejects(createSqliteSandbox(root), /symbolic link/);
  assert.deepEqual(await fs.readdir(outside), []);
});
