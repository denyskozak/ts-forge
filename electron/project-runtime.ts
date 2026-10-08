import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import { executableEnvironment, resolveExecutable, terminate } from './executor';

let preview: ChildProcess | undefined;
let interactiveWindow: BrowserWindow | undefined;
let browserConsole: string[] = [];
let browserFailures: string[] = [];

const r3fRuntimeBridge = String.raw`(() => {
  if (window.__FORGE_R3F_RUNTIME__) return;
  const contexts = [];
  const contextRecords = new WeakMap();
  const frameTimes = [];
  let lastFrame = 0;
  let profileStartedAt = performance.now();
  const resourceKinds = ['Buffer', 'Texture', 'Program', 'Framebuffer', 'Renderbuffer', 'Shader', 'VertexArray'];
  const instrument = (context, canvas, kind) => {
    if (!context || contextRecords.has(context)) return context;
    const record = {
      kind,
      canvas,
      drawCalls: 0,
      triangles: 0,
      resources: Object.fromEntries(resourceKinds.map((name) => [name.toLowerCase(), { created: 0, deleted: 0 }]))
    };
    contextRecords.set(context, record);
    contexts.push(record);
    for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const original = context[method];
      if (typeof original !== 'function') continue;
      context[method] = function(...args) {
        record.drawCalls += 1;
        const mode = args[0];
        const count = Number(args[method.includes('Elements') ? 1 : 2] || 0);
        const instances = method.includes('Instanced') ? Number(args.at(-1) || 1) : 1;
        if (mode === context.TRIANGLES) record.triangles += Math.floor(count / 3) * instances;
        else if (mode === context.TRIANGLE_STRIP || mode === context.TRIANGLE_FAN)
          record.triangles += Math.max(0, count - 2) * instances;
        return original.apply(this, args);
      };
    }
    for (const kindName of resourceKinds) {
      for (const prefix of ['create', 'delete']) {
        const method = prefix + kindName;
        const original = context[method];
        if (typeof original !== 'function') continue;
        context[method] = function(...args) {
          const result = original.apply(this, args);
          record.resources[kindName.toLowerCase()][prefix === 'create' ? 'created' : 'deleted'] += 1;
          return result;
        };
      }
    }
    return context;
  };
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
    const context = originalGetContext.call(this, kind, ...args);
    return /^webgl2?$/.test(String(kind)) ? instrument(context, this, String(kind)) : context;
  };
  const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => originalRequestAnimationFrame((now) => {
    if (now !== lastFrame) {
      const duration = lastFrame ? now - lastFrame : 0;
      lastFrame = now;
      if (duration > 0 && duration < 1000) {
        frameTimes.push(duration);
        if (frameTimes.length > 1200) frameTimes.shift();
      }
    }
    callback(now);
  });
  const bounded = (value, depth = 0, seen = new WeakSet()) => {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 500);
    if (typeof value !== 'object' || depth >= 5 || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => bounded(item, depth + 1, seen));
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, bounded(item, depth + 1, seen)]));
  };
  const contextSnapshot = (record) => {
    const gl = contextRecords.has(record.canvas?.getContext?.(record.kind))
      ? record.canvas.getContext(record.kind)
      : undefined;
    let renderer;
    let vendor;
    try {
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
      vendor = info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl?.getParameter(gl.VENDOR);
    } catch {}
    return {
      kind: record.kind,
      renderer,
      vendor,
      version: gl?.getParameter?.(gl.VERSION),
      shadingLanguage: gl?.getParameter?.(gl.SHADING_LANGUAGE_VERSION),
      drawingBuffer: { width: gl?.drawingBufferWidth || 0, height: gl?.drawingBufferHeight || 0 },
      contextLost: gl?.isContextLost?.() || false,
      drawCalls: record.drawCalls,
      triangles: record.triangles,
      resources: Object.fromEntries(Object.entries(record.resources).map(([name, counts]) => [name, {
        ...counts,
        live: Math.max(0, counts.created - counts.deleted)
      }]))
    };
  };
  window.__FORGE_R3F_RUNTIME__ = {
    resetProfile() {
      profileStartedAt = performance.now();
      frameTimes.length = 0;
      lastFrame = 0;
      for (const record of contexts) {
        record.drawCalls = 0;
        record.triangles = 0;
      }
      return profileStartedAt;
    },
    snapshot() {
      let scene;
      try {
        scene = typeof window.__FORGE_R3F_INSPECT__ === 'function' ? bounded(window.__FORGE_R3F_INSPECT__()) : undefined;
      } catch (error) {
        scene = { error: String(error) };
      }
      return {
        capturedAt: performance.now(),
        profileStartedAt,
        frameTimes: frameTimes.slice(),
        canvases: [...document.querySelectorAll('canvas')].map((canvas, index) => ({
          index,
          width: canvas.width,
          height: canvas.height,
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
          visible: !!canvas.getClientRects().length && getComputedStyle(canvas).visibility !== 'hidden'
        })),
        contexts: contexts.slice(0, 16).map(contextSnapshot),
        scene
      };
    }
  };
})();`;

type BrowserScenarioStep =
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | {
      action: 'press';
      key:
        'Enter' | 'Escape' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Space';
    }
  | {
      action: 'wait';
      selector: string;
      state?: 'visible' | 'hidden' | 'attached';
      timeoutMs?: number;
    }
  | {
      action: 'assert';
      selector: string;
      condition: 'visible' | 'text' | 'value' | 'count';
      expected: string;
    }
  | { action: 'viewport'; preset: 'desktop' | 'tablet' | 'phone' }
  | { action: 'snapshot' }
  | { action: 'r3f_snapshot' }
  | { action: 'profile'; durationMs?: number }
  | { action: 'visual_assert'; expectation: string; selector?: string };

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
      backgroundThrottling: false,
      partition: `forge-local-preview-${randomUUID()}`,
    },
  });
  // Chromium needs an initialized page target before accepting Page-domain
  // scripts reliably. Register the bridge on that target before navigation.
  await interactiveWindow.loadURL('about:blank');
  const debuggerSession = interactiveWindow.webContents.debugger;
  if (!debuggerSession.isAttached()) debuggerSession.attach('1.3');
  await debuggerSession.sendCommand('Page.enable');
  await debuggerSession.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: r3fRuntimeBridge,
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

function percentile(values: number[], percentage: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentage))];
}

type RuntimeSnapshot = {
  capturedAt: number;
  profileStartedAt: number;
  frameTimes: number[];
  canvases: Array<Record<string, unknown>>;
  contexts: Array<{
    drawCalls: number;
    triangles: number;
    contextLost: boolean;
    resources: Record<string, { created: number; deleted: number; live: number }>;
    [key: string]: unknown;
  }>;
  scene?: unknown;
};

async function rawR3fRuntimeSnapshot() {
  return activePage().executeJavaScript(
    `(() => window.__FORGE_R3F_RUNTIME__?.snapshot?.() ?? null)()`,
    true,
  ) as Promise<RuntimeSnapshot | null>;
}

/** Returns browser-side WebGL evidence without relying on React or R3F private internals. */
export async function r3fRuntimeSnapshot() {
  const runtime = await rawR3fRuntimeSnapshot();
  if (!runtime)
    throw new Error('R3F runtime instrumentation is unavailable. Reopen the local preview first.');
  const drawCalls = runtime.contexts.reduce((total, context) => total + context.drawCalls, 0);
  const triangles = runtime.contexts.reduce((total, context) => total + context.triangles, 0);
  const liveResources = runtime.contexts.reduce(
    (total, context) =>
      total + Object.values(context.resources).reduce((sum, resource) => sum + resource.live, 0),
    0,
  );
  return {
    status: runtime.contexts.length ? 'captured' : 'no-webgl-context',
    canvases: runtime.canvases,
    contexts: runtime.contexts,
    drawCalls,
    triangles,
    liveResources,
    scene: runtime.scene,
    sceneGraph: runtime.scene ? 'application-bridge' : 'unavailable',
    note: runtime.scene
      ? 'Semantic scene evidence was supplied by the optional application bridge.'
      : 'WebGL runtime evidence was captured. Semantic objects, cameras and materials require an optional window.__FORGE_R3F_INSPECT__ application bridge because R3F has no stable public runtime graph API.',
    consoleErrors: browserConsole.filter((message) => /error/i.test(message)).slice(-20),
    failedRequests: browserFailures.slice(-20),
  };
}

export async function r3fPerformanceProfile(durationMs: number, signal: AbortSignal) {
  const duration = Math.min(10_000, Math.max(500, Math.round(durationMs)));
  const reset = await activePage().executeJavaScript(
    `(() => window.__FORGE_R3F_RUNTIME__?.resetProfile?.() ?? null)()`,
    true,
  );
  if (reset === null)
    throw new Error('R3F runtime instrumentation is unavailable. Reopen the local preview first.');
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, duration);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Performance profile stopped.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  const runtime = await rawR3fRuntimeSnapshot();
  if (!runtime) throw new Error('R3F runtime instrumentation stopped during profiling.');
  const timings = runtime.frameTimes.filter((value) => Number.isFinite(value) && value > 0);
  const elapsedMs = Math.max(1, runtime.capturedAt - runtime.profileStartedAt);
  const averageFrameMs = timings.length
    ? timings.reduce((total, value) => total + value, 0) / timings.length
    : 0;
  const drawCalls = runtime.contexts.reduce((total, context) => total + context.drawCalls, 0);
  const triangles = runtime.contexts.reduce((total, context) => total + context.triangles, 0);
  return {
    status: timings.length ? 'captured' : 'no-frames',
    durationMs: Math.round(elapsedMs),
    frames: timings.length,
    averageFps: averageFrameMs ? Math.round((1000 / averageFrameMs) * 10) / 10 : 0,
    averageFrameMs: Math.round(averageFrameMs * 100) / 100,
    p50FrameMs: Math.round(percentile(timings, 0.5) * 100) / 100,
    p95FrameMs: Math.round(percentile(timings, 0.95) * 100) / 100,
    maxFrameMs: Math.round(Math.max(0, ...timings) * 100) / 100,
    slowFrames: timings.filter((value) => value > 33.34).length,
    drawCalls,
    triangles,
    contexts: runtime.contexts.length,
    note: 'This is a short local preview sample. GPU and device-specific performance still requires profiling on each target device.',
  };
}

function analyzeBitmap(bitmap: Buffer, width: number, height: number) {
  const pixelCount = width * height;
  const stride = Math.max(1, Math.floor(pixelCount / 20_000));
  const buckets = new Map<number, number>();
  const luminances: number[] = [];
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 4;
    const blue = bitmap[offset] ?? 0;
    const green = bitmap[offset + 1] ?? 0;
    const red = bitmap[offset + 2] ?? 0;
    const alpha = bitmap[offset + 3] ?? 255;
    const luminance = alpha === 0 ? 0 : (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
    luminances.push(luminance);
    const bucket = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const average =
    luminances.reduce((total, value) => total + value, 0) / Math.max(1, luminances.length);
  const variation =
    luminances.reduce((total, value) => total + Math.abs(value - average), 0) /
    Math.max(1, luminances.length);
  const dominant = Math.max(0, ...buckets.values()) / Math.max(1, luminances.length);
  return {
    sampledPixels: luminances.length,
    averageLuminance: Math.round(average * 1000) / 1000,
    colorVariation: Math.round(variation * 1000) / 1000,
    dominantColorRatio: Math.round(dominant * 1000) / 1000,
    colorBuckets: buckets.size,
  };
}

function bitmapDiff(left: Buffer, right: Buffer) {
  const pixels = Math.min(left.length, right.length) / 4;
  const stride = Math.max(1, Math.floor(pixels / 20_000));
  let compared = 0;
  let changed = 0;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * 4;
    const difference =
      (Math.abs(left[offset] - right[offset]) +
        Math.abs(left[offset + 1] - right[offset + 1]) +
        Math.abs(left[offset + 2] - right[offset + 2])) /
      765;
    compared += 1;
    if (difference > 0.08) changed += 1;
  }
  return compared ? changed / compared : 1;
}

async function captureRegion(selector?: string) {
  if (!selector) return activePage().capturePage();
  const checked = z.string().min(1).max(500).parse(selector);
  const rect = await activePage().executeJavaScript(
    `(() => { const element = document.querySelector(${JSON.stringify(checked)}); if (!element) throw new Error('Visual assertion target not found'); const rect = element.getBoundingClientRect(); if (rect.width < 1 || rect.height < 1) throw new Error('Visual assertion target is not visible'); return { x: Math.max(0, Math.floor(rect.x)), y: Math.max(0, Math.floor(rect.y)), width: Math.max(1, Math.ceil(Math.min(innerWidth - Math.max(0, rect.x), rect.width))), height: Math.max(1, Math.ceil(Math.min(innerHeight - Math.max(0, rect.y), rect.height))) }; })()`,
    true,
  );
  return activePage().capturePage(rect);
}

export async function visualAssert(
  dataPath: string,
  input: {
    expectation: string;
    selector?: string;
    baselineScreenshot?: string;
    minWidth?: number;
    minHeight?: number;
    minColorVariation?: number;
    maxDominantColorRatio?: number;
    maxDiffRatio?: number;
  },
) {
  const image = await captureRegion(input.selector);
  const size = image.getSize();
  const signals = analyzeBitmap(image.toBitmap(), size.width, size.height);
  const directory = path.join(dataPath, 'previews');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const screenshot = path.join(directory, `${randomUUID()}.png`);
  await fs.writeFile(screenshot, image.toPNG(), { mode: 0o600 });
  const checks = [
    { name: 'minimum width', passed: size.width >= (input.minWidth ?? 64), actual: size.width },
    { name: 'minimum height', passed: size.height >= (input.minHeight ?? 64), actual: size.height },
    {
      name: 'visible variation',
      passed: signals.colorVariation >= (input.minColorVariation ?? 0.003),
      actual: signals.colorVariation,
    },
    {
      name: 'not a solid frame',
      passed: signals.dominantColorRatio <= (input.maxDominantColorRatio ?? 0.995),
      actual: signals.dominantColorRatio,
    },
  ];
  let baselineDiffRatio: number | undefined;
  if (input.baselineScreenshot) {
    const previewsRoot = path.resolve(directory);
    const baselinePath = path.resolve(input.baselineScreenshot);
    const relative = path.relative(previewsRoot, baselinePath);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Visual baselines must come from the private Forge previews directory.');
    const { nativeImage } = await import('electron');
    const baseline = nativeImage.createFromPath(baselinePath);
    const baselineSize = baseline.getSize();
    baselineDiffRatio =
      baselineSize.width === size.width && baselineSize.height === size.height
        ? bitmapDiff(image.toBitmap(), baseline.toBitmap())
        : 1;
    checks.push({
      name: 'baseline difference',
      passed: baselineDiffRatio <= (input.maxDiffRatio ?? 0.02),
      actual: Math.round(baselineDiffRatio * 10000) / 10000,
    });
  }
  const passed = checks.every((check) => check.passed);
  return {
    status: passed ? 'passed' : 'failed',
    passed,
    expectation: input.expectation,
    selector: input.selector,
    screenshot,
    width: size.width,
    height: size.height,
    ...signals,
    ...(baselineDiffRatio === undefined
      ? {}
      : { baselineDiffRatio: Math.round(baselineDiffRatio * 10000) / 10000 }),
    checks,
    semanticStatus: 'not-evaluated',
    note: 'Forge verified deterministic pixel signals and an optional local baseline. Understanding whether the image semantically matches the prose expectation requires a configured vision-capable local model.',
  };
}

const scenarioSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'scenario';

export async function browserScenario(
  dataPath: string,
  workspaceRoot: string,
  input: { name: string; steps: BrowserScenarioStep[]; replay?: boolean; save?: boolean },
  signal: AbortSignal,
) {
  const workspaceId = createHash('sha256')
    .update(path.resolve(workspaceRoot))
    .digest('hex')
    .slice(0, 16);
  const directory = path.join(dataPath, 'browser-scenarios', workspaceId);
  const file = path.join(directory, `${scenarioSlug(input.name)}.json`);
  let steps = input.steps;
  if (input.replay) {
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { steps?: BrowserScenarioStep[] };
    steps = Array.isArray(saved.steps) ? saved.steps : [];
  }
  if (!steps.length) throw new Error('A browser scenario needs at least one step.');
  if (steps.length > 30) throw new Error('A browser scenario is limited to 30 steps.');
  if (
    input.save !== false &&
    steps.some(
      (step) =>
        step.action === 'fill' &&
        /pass(word)?|token|secret|api.?key|credential/i.test(step.selector),
    )
  )
    throw new Error('Scenarios containing sensitive form fields can run with save=false only.');
  const startedAt = Date.now();
  const results: Array<{ step: number; action: string; passed: boolean; detail?: string }> = [];
  for (let index = 0; index < steps.length; index += 1) {
    signal.throwIfAborted();
    const step = steps[index];
    try {
      let result: Record<string, unknown> | undefined;
      if (step.action === 'click') await browserClick(step.selector);
      else if (step.action === 'fill') await browserFill(step.selector, step.value);
      else if (step.action === 'press') await browserPress(step.key);
      else if (step.action === 'wait')
        result = await browserWait(
          step.selector,
          step.state ?? 'visible',
          step.timeoutMs ?? 5000,
          signal,
        );
      else if (step.action === 'assert')
        result = await browserAssert(step.selector, step.condition, step.expected, signal);
      else if (step.action === 'viewport') await browserViewport(step.preset);
      else if (step.action === 'snapshot') await browserSnapshot();
      else if (step.action === 'r3f_snapshot') await r3fRuntimeSnapshot();
      else if (step.action === 'profile')
        result = await r3fPerformanceProfile(step.durationMs ?? 1500, signal);
      else if (step.action === 'visual_assert')
        result = await visualAssert(dataPath, {
          expectation: step.expectation,
          selector: step.selector,
        });
      const passed = result?.passed !== false && result?.status !== 'failed';
      results.push({ step: index + 1, action: step.action, passed });
      if (!passed) break;
    } catch (cause) {
      results.push({
        step: index + 1,
        action: step.action,
        passed: false,
        detail: cause instanceof Error ? cause.message.slice(0, 300) : 'Step failed',
      });
      break;
    }
  }
  if (input.save !== false && !input.replay) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      file,
      `${JSON.stringify({ version: 1, name: input.name, steps }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  const passed = results.length === steps.length && results.every((result) => result.passed);
  return {
    status: passed ? 'passed' : 'failed',
    passed,
    name: input.name,
    steps: results,
    totalSteps: steps.length,
    completedSteps: results.length,
    durationMs: Date.now() - startedAt,
    saved: input.save !== false,
    replayable: input.save !== false || input.replay === true,
  };
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
