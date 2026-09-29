import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readText, scanFiles } from './workspace';
import type { AnalysisRequest } from './analysis-engine';
export async function queryTypes(
  root: string,
  query: AnalysisRequest['query'],
  signal: AbortSignal,
) {
  const scan = await scanFiles(root, 10000, signal),
    files: AnalysisRequest['files'] = [];
  let bytes = 0;
  await readText(root, query.path);
  const selected = scan.files
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
    .sort((a, b) => (a === query.path ? -1 : b === query.path ? 1 : a.localeCompare(b)));
  for (const filename of selected) {
    signal.throwIfAborted();
    if (files.length >= 500 || bytes > 8_000_000) break;
    try {
      const source = await readText(root, filename);
      bytes += Buffer.byteLength(source);
      files.push({ path: filename, source });
    } catch {}
  }
  const request = { files, query },
    entry = typeof __dirname === 'string' ? path.join(__dirname, 'analysis-worker.js') : '';
  if (!existsSync(entry)) {
    const { languageQuery } = await import('./analysis-engine');
    return languageQuery(request);
  }
  return new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(entry, { resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      void worker.terminate();
    };
    const stop = () => {
      finish();
      reject(new Error('TypeScript analysis cancelled.'));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('TypeScript analysis exceeded 20 seconds.'));
    }, 20000);
    signal.addEventListener('abort', stop, { once: true });
    worker.once('error', (error) => {
      finish();
      reject(error);
    });
    worker.once('message', (message) => {
      finish();
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    });
    worker.postMessage(request);
    if (signal.aborted) stop();
  });
}
