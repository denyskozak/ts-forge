import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {
  discoverPackageScripts,
  gitCreateBranch,
  gitStage,
  mutatePackages,
  scaffoldProject,
} from '../electron/development-tools';
import {
  browserClick,
  browserFill,
  browserOpen,
  browserPress,
  browserScreenshot,
  closeInteractiveBrowser,
} from '../electron/project-runtime';

test('development tools discover scripts and reject command and path injection before execution', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-dev-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { dev: 'vite', test: 'vitest run' } }),
  );
  assert.deepEqual((await discoverPackageScripts(root)).scripts, [
    { name: 'dev', command: 'vite' },
    { name: 'test', command: 'vitest run' },
  ]);
  await assert.rejects(
    mutatePackages(root, 'add', ['react; touch /tmp/forge-owned'], false, AbortSignal.timeout(100)),
  );
  await assert.rejects(gitCreateBranch(root, '-c'), /Invalid|string|validation/i);
  await assert.rejects(gitStage(root, ['../outside']), /outside|escapes|path/i);
  await fs.writeFile(path.join(root, 'README.md'), 'not empty');
  await assert.rejects(
    scaffoldProject(root, 'react', 'safe-name', AbortSignal.timeout(100)),
    /empty workspace/i,
  );
});

test('interactive browser stays on loopback and performs visible UI actions', async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-browser-'));
  const server = createServer((_request, response) => {
    response.end(
      '<!doctype html><title>Fixture</title><input aria-label="Name"><button onclick="document.body.dataset.clicked=\'yes\'">Save</button>',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await closeInteractiveBrowser();
    server.close();
    server.closeAllConnections();
    await fs.rm(data, { recursive: true, force: true });
  });
  const port = (server.address() as { port: number }).port;
  await assert.rejects(browserOpen('https://example.com', AbortSignal.timeout(1000)), /local/i);
  if (!process.versions.electron) return;
  const opened = await browserOpen(`http://127.0.0.1:${port}`, AbortSignal.timeout(10_000));
  assert.equal(opened.title, 'Fixture');
  assert.ok(opened.elements.some((item: { name?: string }) => item.name === 'Name'));
  await browserFill('[aria-label="Name"]', 'Forge');
  await browserPress('Tab');
  const clicked = await browserClick('button');
  assert.match(clicked.text, /Save/);
  const screenshot = await browserScreenshot(data);
  assert.ok((await fs.stat(screenshot.screenshot)).size > 0);
});
