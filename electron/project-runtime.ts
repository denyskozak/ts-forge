import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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
