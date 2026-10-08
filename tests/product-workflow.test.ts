import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configureProcessRegistry,
  listPackageProcesses,
  startPackageProcess,
  stopPackageProcess,
} from '../electron/development-tools';
import {
  analyzeProductArchitecture,
  createDisposableSqlite,
  PRODUCT_RECIPES,
} from '../electron/product-analysis';

test('T3 product analysis maps procedures, data models, contracts and destructive migrations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-product-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src/server/api/routers'), { recursive: true });
  await fs.mkdir(path.join(root, 'prisma/migrations/001_drop_legacy'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/app/api/health'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src/server/api/routers/post.ts'),
    `export const postRouter = createTRPCRouter({
      list: publicProcedure.query(() => []),
      remove: protectedProcedure.mutation(() => true),
    });`,
  );
  await fs.writeFile(
    path.join(root, 'prisma/schema.prisma'),
    `model Post { id String @id\n title String\n @@index([title])\n }`,
  );
  await fs.writeFile(
    path.join(root, 'prisma/migrations/001_drop_legacy/migration.sql'),
    'DROP TABLE Legacy;',
  );
  await fs.writeFile(
    path.join(root, 'src/app/api/health/route.ts'),
    `export const GET = () => Response.json({ ok: true });`,
  );
  await fs.writeFile(
    path.join(root, 'openapi.json'),
    JSON.stringify({ openapi: '3.1.0', paths: { '/health': {} } }),
  );

  const report = await analyzeProductArchitecture(root);
  assert.ok(report.detected.includes('tRPC'));
  assert.ok(report.detected.includes('Prisma'));
  assert.ok(report.detected.includes('OpenAPI'));
  assert.deepEqual(
    report.trpc.procedures.map((item) => item.name),
    ['list', 'remove'],
  );
  assert.equal(report.database.models[0].name, 'Post');
  assert.equal(report.migrations.destructive.length, 1);
  assert.ok(report.contracts.some((item) => item.kind === 'http-route'));
  assert.deepEqual(
    PRODUCT_RECIPES.map((item) => item.id),
    ['saas', 'storefront', 'storefront-react', 'dashboard', 'api', 'monorepo'],
  );

  const sqlite = await createDisposableSqlite(root);
  assert.equal(sqlite.disposable, true);
  assert.equal((await fs.stat(sqlite.database)).mode & 0o777, 0o600);
});

test('development processes persist ownership and can be recovered and stopped', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-process-'));
  const state = path.join(root, 'state');
  const project = path.join(root, 'project');
  await fs.mkdir(state);
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ scripts: { dev: 'node server.mjs' } }),
  );
  await fs.writeFile(
    path.join(project, 'server.mjs'),
    `import http from 'node:http';
     const server = http.createServer((_, response) => response.end('ok'));
     server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));`,
  );
  await configureProcessRegistry(state);
  const started = await startPackageProcess(project, 'dev');
  t.after(async () => {
    const current = listPackageProcesses(project).find((item) => item.id === started.id);
    if (current?.running) await stopPackageProcess(project, started.id);
    await fs.rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5_000;
  while (!/127\.0\.0\.1/.test(listPackageProcesses(project)[0]?.output ?? '')) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(listPackageProcesses(project)[0].running, true);
  assert.match(listPackageProcesses(project)[0].output, /127\.0\.0\.1/);

  const recovered = await configureProcessRegistry(state);
  assert.equal(recovered[0].recovered, true);
  assert.equal(recovered[0].pid, started.pid);
  const stopped = await stopPackageProcess(project, started.id);
  assert.equal(stopped.running, false);
  await new Promise((resolve) => setTimeout(resolve, 100));
});
