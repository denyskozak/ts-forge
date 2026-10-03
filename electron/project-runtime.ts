import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import { cleanEnvironment, terminate } from './executor';

let preview: ChildProcess | undefined;
let interactiveWindow: BrowserWindow | undefined;
let browserConsole: string[] = [];
let browserFailures: string[] = [];

function run(command: string, args: string[], root: string, signal: AbortSignal) {
  return new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: cleanEnvironment({ CI: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    const append = (chunk: Buffer) => {
      output = (output + chunk).slice(-24_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const stop = () => terminate(child);
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      signal.removeEventListener('abort', stop);
      resolve({ exitCode, output });
    });
  });
}

export async function installPnpmDependencies(root: string, signal: AbortSignal) {
  await fs.access(path.join(root, 'package.json'));
  const result = await run(
    'pnpm',
    ['install', '--ignore-scripts', '--frozen-lockfile=false'],
    root,
    signal,
  );
  return { packageManager: 'pnpm', scriptsIgnored: true, ...result };
}

export async function startLocalPreview(root: string, signal: AbortSignal) {
  if (preview && !preview.killed) terminate(preview);
  await fs.access(path.join(root, 'node_modules', 'vite'));
  preview = spawn(
    'pnpm',
    ['exec', 'vite', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
    {
      cwd: root,
      env: cleanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let output = '';
  const append = (chunk: Buffer) => {
    output = (output + chunk).slice(-8000);
  };
  preview.stdout?.on('data', append);
  preview.stderr?.on('data', append);
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

export function stopLocalPreview() {
  if (preview && !preview.killed) terminate(preview);
  preview = undefined;
}

/** Opens only the project loopback preview and returns bounded browser evidence for the agent. */
export async function inspectLocalPreview(url: string, dataPath: string, signal: AbortSignal) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '4173')
    throw new Error('Browser inspection is limited to the local Vite preview on 127.0.0.1:4173.');
  // Keep Playwright out of the Electron main bundle; it is loaded only when a local audit runs.
  const { chromium } = await (new Function('specifier', 'return import(specifier)')(
    '@playwright/test',
  ) as Promise<typeof import('@playwright/test')>);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) =>
      failedRequests.push(
        `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`,
      ),
    );
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });
    signal.throwIfAborted();
    const screenshotDirectory = path.join(dataPath, 'previews');
    await fs.mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
    const screenshot = path.join(screenshotDirectory, `${randomUUID()}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    const evidence = await page.evaluate(() => ({
      title: document.title,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 8000),
      headings: [...document.querySelectorAll('h1,h2,h3')]
        .map((item) => item.textContent?.trim())
        .filter(Boolean)
        .slice(0, 30),
      controls: [...document.querySelectorAll('button,input,[role="button"]')]
        .map(
          (item) =>
            item.getAttribute('aria-label') ||
            item.textContent?.trim() ||
            item.getAttribute('name'),
        )
        .filter(Boolean)
        .slice(0, 60),
      canvases: document.querySelectorAll('canvas').length,
    }));
    return {
      url,
      screenshot,
      ...evidence,
      consoleErrors: consoleErrors.slice(0, 30),
      failedRequests: failedRequests.slice(0, 30),
      note: 'DOM and browser diagnostics were inspected locally. A screenshot was saved for human review; visual interpretation needs a configured vision-capable local model.',
    };
  } finally {
    await browser.close();
  }
}

function localPreviewUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname))
    throw new Error('Interactive browser access is limited to local HTTP preview URLs.');
  if (!parsed.port) throw new Error('Local preview URL must include a port.');
  return parsed.toString();
}

export async function browserOpen(url: string, signal: AbortSignal) {
  const target = localPreviewUrl(url);
  const { BrowserWindow } = await import('electron');
  interactiveWindow?.destroy();
  browserConsole = [];
  browserFailures = [];
  interactiveWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: `forge-local-preview-${randomUUID()}`,
    },
  });
  interactiveWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const request = new URL(details.url);
        callback({
          cancel:
            request.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(request.hostname),
        });
      } catch {
        callback({ cancel: true });
      }
    },
  );
  interactiveWindow.webContents.on('console-message', (_event, level, message) => {
    browserConsole.push(`${level}: ${message}`);
  });
  interactiveWindow.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    browserFailures.push(`${code} ${failedUrl} — ${description}`);
  });
  await interactiveWindow.loadURL(target);
  signal.throwIfAborted();
  return browserSnapshot();
}

function activePage() {
  if (!interactiveWindow || interactiveWindow.isDestroyed())
    throw new Error('Open a local preview in the browser first.');
  return interactiveWindow.webContents;
}

export async function browserSnapshot() {
  const page = activePage();
  const snapshot = await page.executeJavaScript(
    `(() => ({
    url: location.href,
    title: document.title,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12_000),
    elements: [...document.querySelectorAll('a,button,input,textarea,select,[role]')]
      .slice(0, 160)
      .map((element, index) => ({
        index,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        name: element.getAttribute('aria-label') || element.getAttribute('name') || element.textContent?.trim().slice(0, 160),
        disabled: element.disabled || undefined,
      })),
    canvases: document.querySelectorAll('canvas').length,
  }))()`,
    true,
  );
  return {
    ...snapshot,
    console: browserConsole.slice(-40),
    failedRequests: browserFailures.slice(-40),
  };
}

export async function browserClick(selector: string) {
  const checked = z.string().min(1).max(500).parse(selector);
  await activePage().executeJavaScript(
    `(() => { const element = document.querySelector(${JSON.stringify(checked)}); if (!(element instanceof HTMLElement)) throw new Error('Element not found'); element.click(); })()`,
    true,
  );
  return browserSnapshot();
}

export async function browserFill(selector: string, value: string) {
  const checked = z.string().min(1).max(500).parse(selector);
  const text = z.string().max(5000).parse(value);
  await activePage().executeJavaScript(
    `(() => { const element = document.querySelector(${JSON.stringify(checked)}); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('Editable element not found'); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set; setter?.call(element, ${JSON.stringify(text)}); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    true,
  );
  return browserSnapshot();
}

export async function browserPress(key: string) {
  const checked = z
    .enum(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'])
    .parse(key);
  await activePage().sendInputEvent({
    type: 'keyDown',
    keyCode: checked === 'Space' ? ' ' : checked,
  });
  await activePage().sendInputEvent({
    type: 'keyUp',
    keyCode: checked === 'Space' ? ' ' : checked,
  });
  return browserSnapshot();
}

export async function browserScreenshot(dataPath: string) {
  const directory = path.join(dataPath, 'previews');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const screenshot = path.join(directory, `${randomUUID()}.png`);
  const image = await activePage().capturePage();
  await fs.writeFile(screenshot, image.toPNG());
  return { screenshot, ...(await browserSnapshot()) };
}

export async function closeInteractiveBrowser() {
  interactiveWindow?.destroy();
  interactiveWindow = undefined;
}
