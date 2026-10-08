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
  browserScenario,
  browserScreenshot,
  closeInteractiveBrowser,
  r3fPerformanceProfile,
  r3fRuntimeSnapshot,
  visualAssert,
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

test('interactive browser captures WebGL runtime, pixels and reusable scenarios', async (t) => {
  if (!process.versions.electron) return;
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-r3f-runtime-'));
  const server = createServer((_request, response) => {
    response.end(`<!doctype html><title>R3F fixture</title>
      <canvas aria-label="Game scene" width="320" height="180"></canvas>
      <script>
        const canvas = document.querySelector('canvas');
        const gl = canvas.getContext('webgl');
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, 160, 180);
        gl.clearColor(0.05, 0.1, 0.3, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.scissor(160, 0, 160, 180);
        gl.clearColor(0.9, 0.3, 0.1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.createBuffer();
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        requestAnimationFrame(function render() {
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          requestAnimationFrame(render);
        });
      </script>`);
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
  await browserOpen(`http://127.0.0.1:${port}`, AbortSignal.timeout(10_000));
  const runtime = await r3fRuntimeSnapshot();
  assert.equal(runtime.status, 'captured');
  assert.equal(runtime.contexts.length, 1);
  assert.ok(runtime.drawCalls >= 1);
  assert.ok(runtime.liveResources >= 1);

  const profile = await r3fPerformanceProfile(500, AbortSignal.timeout(2000));
  assert.equal(profile.status, 'captured');
  assert.ok(profile.frames > 0);
  assert.ok(profile.averageFps > 0);

  const visual = await visualAssert(data, {
    selector: 'canvas',
    expectation: 'The game canvas is visible and not blank.',
  });
  assert.equal(visual.passed, true);
  assert.ok((await fs.stat(visual.screenshot)).size > 0);

  const scenario = await browserScenario(
    data,
    data,
    {
      name: 'r3f smoke',
      steps: [
        { action: 'assert', selector: 'canvas', condition: 'visible', expected: 'true' },
        { action: 'r3f_snapshot' },
        {
          action: 'visual_assert',
          selector: 'canvas',
          expectation: 'The canvas remains rendered.',
        },
      ],
      save: true,
    },
    AbortSignal.timeout(5000),
  );
  assert.equal(scenario.passed, true);
  const replay = await browserScenario(
    data,
    data,
    { name: 'r3f smoke', steps: [], replay: true },
    AbortSignal.timeout(5000),
  );
  assert.equal(replay.passed, true);
});
