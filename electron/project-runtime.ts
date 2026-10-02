import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanEnvironment, terminate } from './executor';

let preview: ChildProcess | undefined;

function run(command: string, args: string[], root: string, signal: AbortSignal) {
  return new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: cleanEnvironment({ CI: '1' }), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    const append = (chunk: Buffer) => { output = (output + chunk).slice(-24_000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const stop = () => terminate(child);
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', reject);
    child.on('close', (exitCode) => { signal.removeEventListener('abort', stop); resolve({ exitCode, output }); });
  });
}

export async function installPnpmDependencies(root: string, signal: AbortSignal) {
  await fs.access(path.join(root, 'package.json'));
  const result = await run('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile=false'], root, signal);
  return { packageManager: 'pnpm', scriptsIgnored: true, ...result };
}

export async function startLocalPreview(root: string, signal: AbortSignal) {
  if (preview && !preview.killed) terminate(preview);
  await fs.access(path.join(root, 'node_modules', 'vite'));
  preview = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
    cwd: root, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let output = '';
  const append = (chunk: Buffer) => { output = (output + chunk).slice(-8000); };
  preview.stdout?.on('data', append); preview.stderr?.on('data', append);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (preview.exitCode !== null && preview.exitCode !== undefined)
      throw new Error(`Vite preview exited early: ${output}`);
    if (/127\.0\.0\.1:4173/.test(output)) return { url: 'http://127.0.0.1:4173', output };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  terminate(preview);
  throw new Error(`Vite preview did not become ready: ${output}`);
}

export function stopLocalPreview() { if (preview && !preview.killed) terminate(preview); preview = undefined; }

/** Opens only the project loopback preview and returns bounded browser evidence for the agent. */
export async function inspectLocalPreview(url: string, dataPath: string, signal: AbortSignal) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '4173')
    throw new Error('Browser inspection is limited to the local Vite preview on 127.0.0.1:4173.');
  // Keep Playwright out of the Electron main bundle; it is loaded only when a local audit runs.
  const { chromium } = (0, eval)('require')('@playwright/test') as typeof import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`));
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });
    signal.throwIfAborted();
    const screenshotDirectory = path.join(dataPath, 'previews');
    await fs.mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
    const screenshot = path.join(screenshotDirectory, `${randomUUID()}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    const evidence = await page.evaluate(() => ({
      title: document.title,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 8000),
      headings: [...document.querySelectorAll('h1,h2,h3')].map((item) => item.textContent?.trim()).filter(Boolean).slice(0, 30),
      controls: [...document.querySelectorAll('button,input,[role="button"]')].map((item) => item.getAttribute('aria-label') || item.textContent?.trim() || item.getAttribute('name')).filter(Boolean).slice(0, 60),
      canvases: document.querySelectorAll('canvas').length,
    }));
    return { url, screenshot, ...evidence, consoleErrors: consoleErrors.slice(0, 30), failedRequests: failedRequests.slice(0, 30), note: 'DOM and browser diagnostics were inspected locally. A screenshot was saved for human review; visual interpretation needs a configured vision-capable local model.' };
  } finally { await browser.close(); }
}
