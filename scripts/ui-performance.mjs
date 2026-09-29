import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const temp = await mkdtemp(path.join(os.tmpdir(), 'forge-ui-perf-'));
const project = path.join(temp, 'project'),
  data = path.join(temp, 'state');
await mkdir(project);
await mkdir(data);
const messages = Array.from({ length: 600 }, (_, i) => ({
  id: String(i),
  role: i % 3 === 0 ? 'tool' : i % 3 === 1 ? 'user' : 'assistant',
  name: i % 3 === 0 ? 'read_file' : undefined,
  content:
    i % 3 === 0
      ? 'output '.repeat(3000)
      : `Message ${i}\n\n` + 'A paragraph with **formatting** and `code`.\n\n'.repeat(15),
  time: i,
}));
await writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    workspacePath: project,
    sessions: [
      { id: 'stress', title: 'Performance fixture', workspace: project, messages, updatedAt: 0 },
    ],
  }),
);
const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  env: { ...process.env, NODE_ENV: 'test', FORGE_TEST_DATA: data },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Performance fixture', exact: true }).click();
  const history = page.locator('.message-list');
  await history.getByRole('button', { name: 'Show older messages (540)' }).waitFor();
  assert.equal(await history.locator(':scope > article, :scope > details').count(), 60);
  assert.equal(await history.locator('.tool-message pre').count(), 0);
  await history.getByRole('button', { name: 'Show older messages (540)' }).click();
  assert.equal(await history.locator(':scope > article, :scope > details').count(), 120);
  const tool = history.locator('.tool-message').first();
  await tool.locator('summary').click();
  await tool.locator('pre').waitFor();
  await page.evaluate(() => {
    window.__perf = { gaps: [], longTasks: [] };
    let last = performance.now();
    const tick = (now) => {
      window.__perf.gaps.push(now - last);
      last = now;
      window.__perf.frame = requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__perf.observer = new PerformanceObserver((list) =>
      window.__perf.longTasks.push(...list.getEntries().map((entry) => entry.duration)),
    );
    window.__perf.observer.observe({ type: 'longtask' });
  });
  // Push realistic IPC bursts while typing, without contacting or changing a model.
  const streaming = app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 25; j++)
        window.webContents.send('agent-event', { type: 'token', text: 'chunk ' });
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  });
  const started = Date.now();
  await page.getByRole('textbox', { name: 'Message Forge' }).fill('Typing remains available');
  assert.equal(
    await page.getByRole('textbox', { name: 'Message Forge' }).inputValue(),
    'Typing remains available',
  );
  const typingRoundTripMs = Date.now() - started;
  await streaming;
  const metrics = await page.evaluate(() => {
    const data = window.__perf;
    cancelAnimationFrame(data.frame);
    data.observer.disconnect();
    return {
      frames: data.gaps.length,
      maxFrameGapMs: Math.max(...data.gaps),
      longTasks: data.longTasks,
    };
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        messages: 600,
        initiallyRendered: 60,
        afterReveal: 120,
        typingRoundTripMs,
        ...metrics,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: bounded history, older messages, deferred tool content, IPC burst and composer',
  );
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
