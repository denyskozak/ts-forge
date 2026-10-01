import { Worker } from 'node:worker_threads';
import { existsSync, watch, type FSWatcher, promises as fs } from 'node:fs';
import path from 'node:path';
import { readText, safePath, scanFiles } from './workspace';
import { createAnalysisEngine, type AnalysisRequest } from './analysis-engine';
import type { ImpactReport } from '../shared/task';
type Result = ReturnType<ReturnType<typeof createAnalysisEngine>['query']>;
interface WorkspaceService {
  worker?: Worker;
  engine?: ReturnType<typeof createAnalysisEngine>;
  watcher?: FSWatcher;
  dirty: boolean;
  scannedAt: number;
  files: AnalysisRequest['files'];
  complete: boolean;
  skipped: number;
  cache: Map<string, { stamp: string; source: string }>;
  queue: Promise<unknown>;
  usedAt: number;
  pending?: { reject: (error: Error) => void };
  revision: number;
}
const services = new Map<string, WorkspaceService>();
let requestId = 0;
export function closeAnalysis(root?: string) {
  for (const [key, service] of services)
    if (!root || key === path.resolve(root)) {
      services.delete(key);
      service.watcher?.close();
      service.engine?.dispose();
      service.pending?.reject(new Error('Workspace analysis closed.'));
      void service.worker?.terminate();
    }
}
export function invalidateAnalysis(root: string) {
  const service = services.get(path.resolve(root));
  if (service) {
    service.dirty = true;
    service.revision++;
  }
}
function getService(root: string) {
  let service = services.get(root);
  if (service) return service;
  if (services.size >= 3)
    closeAnalysis([...services].sort((a, b) => a[1].usedAt - b[1].usedAt)[0][0]);
  service = {
    dirty: true,
    scannedAt: 0,
    files: [],
    complete: false,
    skipped: 0,
    cache: new Map(),
    queue: Promise.resolve(),
    usedAt: Date.now(),
    revision: 0,
  };
  services.set(root, service);
  try {
    service.watcher = watch(root, { recursive: true, persistent: false }, () =>
      invalidateAnalysis(root),
    );
    service.watcher.on('error', () => invalidateAnalysis(root));
  } catch {
    /* Periodic re-scan remains available on unsupported watchers. */
  }
  return service;
}
async function snapshot(
  root: string,
  service: WorkspaceService,
  query: AnalysisRequest['query'],
  signal: AbortSignal,
) {
  if (query.kind !== 'impact') await readText(root, query.path);
  else for (const target of query.paths ?? [query.path]) await safePath(root, target, true);
  const needsTarget = query.kind !== 'impact' && !service.files.some((f) => f.path === query.path);
  if (!service.dirty && !needsTarget && Date.now() - service.scannedAt < 2000) return;
  const revision = service.revision;
  const scan = await scanFiles(root, 10000, signal);
  const selected = scan.files
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f) || /\.json$/.test(f))
    .sort((a, b) => (a === query.path ? -1 : b === query.path ? 1 : a.localeCompare(b)));
  const files: AnalysisRequest['files'] = [],
    nextCache: WorkspaceService['cache'] = new Map();
  let bytes = 0,
    skipped = 0;
  for (const file of selected) {
    signal.throwIfAborted();
    if (files.length >= 2000 || bytes >= 16_000_000) {
      skipped += selected.length - files.length - skipped;
      break;
    }
    try {
      const target = await safePath(root, file),
        stat = await fs.stat(target);
      const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      const cached = service.cache.get(file);
      const source = cached?.stamp === stamp ? cached.source : await readText(root, file);
      if (bytes + Buffer.byteLength(source) > 16_000_000) {
        skipped++;
        continue;
      }
      bytes += Buffer.byteLength(source);
      files.push({ path: file, source });
      nextCache.set(file, { stamp, source });
    } catch {
      skipped++;
    }
  }
  service.files = files;
  service.cache = nextCache;
  service.complete = scan.complete && skipped === 0;
  service.skipped = skipped;
  service.scannedAt = Date.now();
  service.dirty = service.revision !== revision;
}
export function queryTypes(
  root: string,
  query: AnalysisRequest['query'],
  signal: AbortSignal,
): Promise<Result> {
  root = path.resolve(root);
  const service = getService(root);
  const operation = service.queue
    .catch(() => {})
    .then(async () => {
      signal.throwIfAborted();
      service.usedAt = Date.now();
      if (services.get(root) !== service) throw new Error('Workspace analysis was evicted; retry.');
      await snapshot(root, service, query, signal);
      const request: AnalysisRequest = {
        files: service.files,
        query,
        complete: service.complete,
        skipped: service.skipped,
      };
      const entry = typeof __dirname === 'string' ? path.join(__dirname, 'analysis-worker.js') : '';
      if (!existsSync(entry)) {
        service.engine ??= createAnalysisEngine();
        return service.engine.query(request);
      }
      if (!service.worker) {
        service.worker = new Worker(entry, { resourceLimits: { maxOldGenerationSizeMb: 384 } });
        service.worker.on('error', () => {}); // Each active request has its own rejection handler.
        service.worker.unref();
      }
      const worker = service.worker;
      return new Promise<Result>((resolve, reject) => {
        const id = ++requestId;
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          worker.off('message', message);
          worker.off('error', fail);
          worker.off('exit', exited);
          service.pending = undefined;
          worker.unref();
        };
        const fail = (error: Error) => {
          cleanup();
          if (service.worker === worker) service.worker = undefined;
          void worker.terminate();
          reject(error);
        };
        const abort = () => fail(new Error('TypeScript analysis cancelled.'));
        const exited = (code: number) => fail(new Error(`TypeScript worker exited (${code}).`));
        const message = (data: { id: number; error?: string; result: Result }) => {
          if (data.id !== id) return;
          cleanup();
          if (data.error) reject(new Error(data.error));
          else resolve(data.result);
        };
        const timer = setTimeout(
          () => fail(new Error('TypeScript analysis exceeded 20 seconds.')),
          20000,
        );
        service.pending = { reject: fail };
        worker.ref();
        worker.on('message', message);
        worker.once('error', fail);
        worker.once('exit', exited);
        signal.addEventListener('abort', abort, { once: true });
        worker.postMessage({ id, request });
        if (signal.aborted) abort();
      });
    });
  service.queue = operation;
  return operation;
}
export async function analyzeImpact(
  root: string,
  paths: string[],
  signal: AbortSignal,
): Promise<ImpactReport> {
  if (!paths.length || paths.length > 40) throw new Error('Select between 1 and 40 paths.');
  return (await queryTypes(
    root,
    { kind: 'impact', path: paths[0], paths, line: 1, character: 1 },
    signal,
  )) as ImpactReport;
}
