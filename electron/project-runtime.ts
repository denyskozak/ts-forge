import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import { executableEnvironment, resolveExecutable, terminate } from './executor';

let preview: ChildProcess | undefined;
let interactiveWindow: BrowserWindow | undefined;
let browserConsole: string[] = [];
let browserFailures: string[] = [];

function run(command: string, args: string[], root: string, signal: AbortSignal) {
  return new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: executableEnvironment(command, { CI: '1' }),
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
  const pnpm = await resolveExecutable('pnpm');
  const result = await run(
    pnpm,
    ['install', '--ignore-scripts', '--frozen-lockfile=false'],
    root,
    signal,
  );
  return { packageManager: 'pnpm', scriptsIgnored: true, ...result };
}

export async function startLocalPreview(root: string, signal: AbortSignal) {
  if (preview && !preview.killed) terminate(preview);
  await fs.access(path.join(root, 'node_modules', 'vite'));
  const pnpm = await resolveExecutable('pnpm');
  preview = spawn(pnpm, ['exec', 'vite', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
    cwd: root,
    env: executableEnvironment(pnpm),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
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
  if (parsed.username || parsed.password)
    throw new Error('Credentials are not allowed in local preview URLs.');
  if (!parsed.port) throw new Error('Local preview URL must include a port.');
  return parsed.toString();
}

export async function checkLocalHttp(
  url: string,
  signal: AbortSignal,
  input: {
    method?: string;
    body?: string;
    expectedStatus?: number;
    expectedJson?: Record<string, unknown>;
  } = {},
) {
  const target = localPreviewUrl(url);
  const startedAt = Date.now();
  const response = await fetch(target, {
    method: input.method ?? 'GET',
    ...(input.body !== undefined
      ? { body: input.body, headers: { 'Content-Type': 'application/json' } }
      : {}),
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  let body = '';
  let truncated = false;
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        body += decoder.decode(chunk.value.slice(0, Math.max(0, 12000 - body.length)), {
          stream: true,
        });
        if (bytes >= 12000) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(body);
  } catch {}
  const assertions = [
    ...(input.expectedStatus === undefined
      ? []
      : [{ name: 'status', passed: response.status === input.expectedStatus }]),
    ...Object.entries(input.expectedJson ?? {}).map(([key, expected]) => ({
      name: `json.${key}`,
      passed: JSON.stringify(json?.[key]) === JSON.stringify(expected),
    })),
  ];
  return {
    url: target,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type'),
    latencyMs: Date.now() - startedAt,
    body,
    truncated,
    assertions,
    ...(assertions.length ? { passed: assertions.every((item) => item.passed) } : {}),
  };
}

export async function browserOpen(url: string, signal: AbortSignal, relatedUrls: string[] = []) {
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
  interactiveWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  interactiveWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  const origins = new Set(
    [target, ...relatedUrls].map((value) => new URL(localPreviewUrl(value)).origin),
  );
  interactiveWindow.webContents.on('will-navigate', (event, value) => {
    try {
      if (!origins.has(new URL(value).origin)) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  interactiveWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const request = new URL(details.url);
        callback({
          cancel: !origins.has(request.origin),
        });
      } catch {
        callback({ cancel: true });
      }
    },
  );
  interactiveWindow.webContents.on('console-message', (event) => {
    browserConsole = [...browserConsole, `${event.level}: ${event.message.slice(0, 2000)}`].slice(
      -40,
    );
  });
  interactiveWindow.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    browserFailures = [...browserFailures, `${code} ${failedUrl} — ${description}`].slice(-40);
  });
  interactiveWindow.webContents.session.webRequest.onErrorOccurred((details) => {
    browserFailures = [
      ...browserFailures,
      `${details.method} ${details.url} — ${details.error}`,
    ].slice(-40);
  });
  interactiveWindow.webContents.session.webRequest.onCompleted((details) => {
    if (details.statusCode >= 400)
      browserFailures = [
        ...browserFailures,
        `${details.method} ${details.url} — HTTP ${details.statusCode}`,
      ].slice(-40);
  });
  const abort = () => {
    interactiveWindow?.webContents.stop();
  };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 20_000);
  try {
    await interactiveWindow.loadURL(target);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
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
    viewport: { width: innerWidth, height: innerHeight, scaleFactor: devicePixelRatio },
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12_000),
    elements: [...document.querySelectorAll('a,button,input,textarea,select,[role]')]
      .slice(0, 160)
      .map((element, index) => ({
        index,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        name: element.getAttribute('aria-label') || element.getAttribute('name') || element.textContent?.trim().slice(0, 160),
        disabled: element.disabled || undefined,
        selector: (() => { if (!element.dataset.forgeRef) element.dataset.forgeRef = crypto.randomUUID(); return '[data-forge-ref="' + element.dataset.forgeRef + '"]'; })(),
        visible: !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden',
        value: 'value' in element ? String(element.value).slice(0, 500) : undefined,
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
  if (!(await browserWait(checked, 'visible', 5000, AbortSignal.timeout(6000))).passed)
    throw new Error('Element did not become visible.');
  const point = await activePage().executeJavaScript(
    `(() => { const element = document.querySelector(${JSON.stringify(checked)}); if (!(element instanceof HTMLElement) || element.disabled) throw new Error('Element not actionable'); element.scrollIntoView({ block: 'center' }); const rect = element.getBoundingClientRect(); const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2; const top = document.elementFromPoint(x,y); if (!top || !(top === element || element.contains(top))) throw new Error('Element is covered'); return { x: Math.round(x), y: Math.round(y) }; })()`,
    true,
  );
  const debuggerSession = activePage().debugger;
  if (!debuggerSession.isAttached()) debuggerSession.attach('1.3');
  await debuggerSession.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'left',
    clickCount: 1,
  });
  await debuggerSession.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
    button: 'left',
    clickCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  return browserSnapshot();
}

export async function browserFill(selector: string, value: string) {
  const checked = z.string().min(1).max(500).parse(selector);
  const text = z.string().max(5000).parse(value);
  await activePage().executeJavaScript(
    `(() => { const element = document.querySelector(${JSON.stringify(checked)}); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('Editable element not found'); element.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set; setter?.call(element, ${JSON.stringify(text)}); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    true,
  );
  return browserSnapshot();
}

export async function browserPress(key: string) {
  const checked = z
    .enum(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'])
    .parse(key);
  const keys = {
    Enter: 13,
    Escape: 27,
    Tab: 9,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Space: 32,
  };
  const debuggerSession = activePage().debugger;
  if (!debuggerSession.isAttached()) debuggerSession.attach('1.3');
  const event = {
    key: checked === 'Space' ? ' ' : checked,
    code: checked,
    windowsVirtualKeyCode: keys[checked],
    nativeVirtualKeyCode: keys[checked],
  };
  await debuggerSession.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
  await debuggerSession.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
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

export async function browserWait(
  selector: string,
  state: 'visible' | 'hidden' | 'attached',
  timeoutMs: number,
  signal: AbortSignal,
) {
  z.string().min(1).max(500).parse(selector);
  const deadline = Date.now() + Math.min(15000, Math.max(100, timeoutMs));
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const ready = await activePage().executeJavaScript(
      `(() => { const element = document.querySelector(${JSON.stringify(selector)}); const visible = !!element && !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'; return ${state === 'attached' ? '!!element' : state === 'visible' ? 'visible' : '!visible'}; })()`,
    );
    if (ready) return { selector, state, passed: true };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { selector, state, passed: false, error: `Timed out after ${timeoutMs}ms` };
}
export async function browserAssert(
  selector: string,
  condition: 'visible' | 'text' | 'value' | 'count',
  expected: string,
  signal: AbortSignal,
) {
  const checked = z.string().min(1).max(500).parse(selector);
  const deadline = Date.now() + 5000;
  let actual: unknown;
  while (true) {
    signal.throwIfAborted();
    actual = await activePage().executeJavaScript(
      `(() => { const elements = [...document.querySelectorAll(${JSON.stringify(checked)})]; const element = elements[0]; switch (${JSON.stringify(condition)}) { case 'count': return elements.length; case 'visible': return !!element && !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'; case 'text': return element?.textContent?.trim().slice(0, 5000) ?? ''; case 'value': return element?.value ?? ''; } })()`,
    );
    if (String(actual) === expected) return { selector, condition, expected, actual, passed: true };
    if (Date.now() >= deadline) return { selector, condition, expected, actual, passed: false };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
export async function browserSelect(selector: string, value: string) {
  await activePage().executeJavaScript(
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLSelectElement) || element.disabled) throw new Error('Select not actionable'); if (![...element.options].some(option => option.value === ${JSON.stringify(value)})) throw new Error('Option not found'); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    true,
  );
  return browserSnapshot();
}
export async function browserScroll(selector: string) {
  await activePage().executeJavaScript(
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Element not found'); element.scrollIntoView({ block: 'center' }); })()`,
  );
  return browserSnapshot();
}
export async function browserViewport(preset: 'desktop' | 'tablet' | 'phone') {
  activePage();
  const sizes = { desktop: [1440, 900], tablet: [768, 1024], phone: [390, 844] } as const;
  const [width, height] = sizes[preset];
  interactiveWindow!.setContentSize(width, height);
  return { viewport: preset, ...(await browserSnapshot()) };
}
export function showInteractiveBrowser() {
  activePage();
  interactiveWindow!.show();
  interactiveWindow!.focus();
}
