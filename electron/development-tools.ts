import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { executableEnvironment, resolveExecutable, terminate } from './executor';
import { safePath } from './workspace';

const packageName = z
  .string()
  .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-zA-Z0-9.*^~<>=-]+)?$/)
  .max(160);
const gitRef = z
  .string()
  .regex(/^(?!-)(?!.*\.\.)(?!.*[~^:?*\[\\\s])[a-zA-Z0-9._/-]+$/)
  .max(200);
const scriptName = z
  .string()
  .regex(/^[a-zA-Z0-9:_-]+$/)
  .max(100);
const projectName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export async function capture(
  executable: string,
  args: string[],
  root: string,
  signal: AbortSignal,
  timeoutMs = 120_000,
) {
  signal.throwIfAborted();
  return new Promise<{ exitCode: number | null; output: string; cancelled: boolean }>(
    (resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root,
        detached: true,
        env: executableEnvironment(executable, {
          CI: '1',
          COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const append = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-32_000);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const stop = () => terminate(child);
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        reject(error);
      });
      child.once('close', (exitCode) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        resolve({ exitCode, output: output.trim(), cancelled: signal.aborted });
      });
    },
  );
}

async function packageJson(root: string) {
  const parsed = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
    name?: string;
    packageManager?: string;
    scripts?: Record<string, string>;
  };
  return parsed;
}

export async function discoverPackageScripts(root: string) {
  const manifest = await packageJson(root);
  return {
    name: manifest.name ?? path.basename(root),
    packageManager: manifest.packageManager ?? 'pnpm',
    scripts: Object.entries(manifest.scripts ?? {}).map(([name, command]) => ({ name, command })),
  };
}

export async function mutatePackages(
  root: string,
  action: 'add' | 'remove',
  packages: string[],
  development: boolean,
  signal: AbortSignal,
) {
  await packageJson(root);
  const checked = packages.map((item) => packageName.parse(item));
  const args =
    action === 'add'
      ? ['add', ...(development ? ['--save-dev'] : []), '--ignore-scripts', ...checked]
      : ['remove', '--ignore-scripts', ...checked];
  const result = await capture(await resolveExecutable('pnpm'), args, root, signal, 180_000);
  if (result.exitCode !== 0)
    throw new Error(result.output || `pnpm exited with ${result.exitCode}.`);
  return { action, packages: checked, development, lifecycleScripts: false, ...result };
}

type ProcessRecord = {
  id: string;
  root: string;
  script: string;
  startedAt: number;
  child?: ChildProcess;
  pid?: number;
  recovered?: boolean;
  identity?: string;
  ready?: boolean;
  probing?: boolean;
  probedAt?: number;
  output: string;
  exitCode?: number | null;
};
const processes = new Map<string, ProcessRecord>();
let registryPath = '';
let registryQueue = Promise.resolve();
let registryTimer: ReturnType<typeof setTimeout> | undefined;

async function processIdentity(pid: number) {
  const result = await capture(
    '/bin/ps',
    ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
    process.cwd(),
    AbortSignal.timeout(3000),
    3000,
  );
  return result.exitCode === 0 ? result.output : '';
}

function processAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function persistProcesses() {
  if (!registryPath) return;
  const records = [...processes.values()]
    .filter((item) => item.exitCode === undefined && processAlive(item.pid))
    .map(({ id, root, script, startedAt, pid, identity, output }) => ({
      id,
      root,
      script,
      startedAt,
      pid,
      identity,
      output: output.slice(-12_000),
    }));
  const filename = registryPath;
  const snapshot = `${JSON.stringify(records, null, 2)}\n`;
  registryQueue = registryQueue
    .catch(() => {})
    .then(async () => {
      const temporary = `${filename}.tmp`;
      await fs.writeFile(temporary, snapshot, { mode: 0o600 });
      await fs.rename(temporary, filename);
    });
  await registryQueue;
}

export async function configureProcessRegistry(directory: string) {
  clearTimeout(registryTimer);
  registryTimer = undefined;
  if (registryPath === path.join(directory, 'development-processes.json')) await persistProcesses();
  registryPath = path.join(directory, 'development-processes.json');
  processes.clear();
  try {
    const saved = JSON.parse(await fs.readFile(registryPath, 'utf8')) as Array<
      Pick<ProcessRecord, 'id' | 'root' | 'script' | 'startedAt' | 'pid' | 'output' | 'identity'>
    >;
    for (const record of saved) {
      if (!processAlive(record.pid)) continue;
      if (
        !record.pid ||
        !record.identity ||
        (await processIdentity(record.pid)) !== record.identity
      )
        continue;
      const recovered = { ...record, recovered: true };
      processes.set(record.id, recovered);
      await probeProcessHealth(recovered);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await persistProcesses();
  return [...processes.values()].map(processView);
}

export async function startPackageProcess(root: string, script: string) {
  const checked = scriptName.parse(script);
  const manifest = await packageJson(root);
  if (!manifest.scripts?.[checked]) throw new Error(`package.json has no “${checked}” script.`);
  const existing = [...processes.values()].find(
    (item) => item.root === root && item.script === checked && item.exitCode === undefined,
  );
  if (existing) return processView(existing);
  const pnpm = await resolveExecutable('pnpm');
  const command = manifest.scripts[checked];
  const localViteHost = /^vite(?:\s|$)/.test(command) && !/(?:^|\s)--host(?:\s|=|$)/.test(command);
  const child = spawn(
    pnpm,
    ['run', checked, ...(localViteHost ? ['--host', '127.0.0.1'] : [])],
    {
      cwd: root,
      detached: true,
      env: executableEnvironment(pnpm, { FORCE_COLOR: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const record: ProcessRecord = {
    id: randomUUID(),
    root,
    script: checked,
    startedAt: Date.now(),
    child,
    pid: child.pid,
    output: '',
  };
  const append = (chunk: Buffer) => {
    record.output = (record.output + chunk.toString()).slice(-48_000);
    registryTimer ??= setTimeout(() => {
      registryTimer = undefined;
      void persistProcesses().catch(() => {});
    }, 250);
    registryTimer.unref();
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.once('close', (code) => {
    record.exitCode = code;
    void persistProcesses().catch(() => {});
  });
  child.once('error', (error) => {
    record.output = error.message;
    record.exitCode = null;
  });
  if (child.pid) record.identity = await processIdentity(child.pid);
  processes.set(record.id, record);
  await persistProcesses();
  const readyDeadline = Date.now() + 5000;
  while (Date.now() < readyDeadline) {
    if (record.exitCode !== undefined)
      throw new Error(record.output || `Process exited with ${record.exitCode}.`);
    if (processView(record).urls.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await probeProcessHealth(record);
  return processView(record);
}

function processView(record: ProcessRecord) {
  const cleanOutput = record.output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const urls = [
    ...cleanOutput.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/[^\s]*)?/g),
  ].map((match) => match[0]);
  const uniqueUrls = [...new Set(urls)].slice(-5);
  const ports = uniqueUrls.flatMap((value) => {
    try {
      return [Number(new URL(value).port)];
    } catch {
      return [];
    }
  });
  return {
    id: record.id,
    script: record.script,
    startedAt: record.startedAt,
    running: record.exitCode === undefined,
    recovered: record.recovered,
    pid: record.pid,
    exitCode: record.exitCode ?? null,
    urls: uniqueUrls,
    ports,
    health:
      record.exitCode !== undefined
        ? ('stopped' as const)
        : record.ready
          ? ('ready' as const)
          : ('starting' as const),
    output: record.output.slice(-12_000),
  };
}

export function listPackageProcesses(root: string) {
  const selected = [...processes.values()].filter((item) => item.root === root);
  selected.forEach((record) => {
    void probeProcessHealth(record);
  });
  return selected.map(processView);
}

async function probeProcessHealth(record: ProcessRecord) {
  if (record.probing || record.exitCode !== undefined || Date.now() - (record.probedAt ?? 0) < 2000)
    return;
  const url = processView(record).urls[0];
  if (!url) return;
  record.probing = true;
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    record.ready = response.ok;
    await response.body?.cancel();
  } catch {
    record.ready = false;
  } finally {
    record.probing = false;
    record.probedAt = Date.now();
  }
}

export async function stopPackageProcess(root: string, id: string) {
  const record = processes.get(id);
  if (!record || record.root !== root) throw new Error('Development process not found.');
  if (record.exitCode === undefined) {
    if (record.child) terminate(record.child);
    else if (record.pid && processAlive(record.pid)) {
      if (!record.identity || (await processIdentity(record.pid)) !== record.identity)
        throw new Error('Process identity changed; refusing to signal a reused PID.');
      try {
        process.kill(process.platform === 'win32' ? record.pid : -record.pid, 'SIGTERM');
      } catch {}
    }
    const deadline = Date.now() + 4000;
    while (processAlive(record.pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (processAlive(record.pid))
      throw new Error('Process did not stop. Verify its ownership before retrying.');
    record.exitCode ??= null;
  }
  await persistProcesses();
  return processView(record);
}

export async function restartPackageProcess(root: string, id: string) {
  const record = processes.get(id);
  if (!record || record.root !== root) throw new Error('Development process not found.');
  const script = record.script;
  await stopPackageProcess(root, id);
  processes.delete(id);
  return startPackageProcess(root, script);
}

export async function stopAllPackageProcesses() {
  for (const record of processes.values())
    if (record.exitCode === undefined) await stopPackageProcess(record.root, record.id);
}

export type ProjectTemplate = 'react' | 'next' | 'expo' | 'r3f' | 'api' | 't3';
export const projectTemplates = [
  {
    id: 'react',
    label: 'React + Vite',
    command: 'pnpm create vite . --template react-ts --no-interactive',
  },
  {
    id: 'next',
    label: 'Next.js App Router',
    command: 'pnpm create next-app@latest . --yes --use-pnpm',
  },
  { id: 'expo', label: 'Expo / React Native', command: 'pnpm create expo-app .' },
  {
    id: 'r3f',
    label: 'React Three Fiber',
    command: 'Vite React TS + @react-three/fiber, drei and three',
  },
  {
    id: 'api',
    label: 'Hono Node API',
    command: 'pnpm create hono@latest . --template nodejs --pm pnpm --install',
  },
  {
    id: 't3',
    label: 'T3 full stack',
    command: 'pnpm create t3-app@latest . --default --noInstall --noGit',
  },
] as const;

export async function scaffoldProject(
  root: string,
  template: ProjectTemplate,
  name: string,
  signal: AbortSignal,
) {
  projectName.parse(name);
  const entries = (await fs.readdir(root)).filter(
    (entry) => !['.git', '.DS_Store'].includes(entry),
  );
  if (entries.length) throw new Error('Project scaffolding requires an empty workspace directory.');
  const commands: string[][] =
    template === 'react'
      ? [['create', 'vite', '.', '--template', 'react-ts', '--no-interactive']]
      : template === 'next'
        ? [['create', 'next-app@latest', '.', '--yes', '--use-pnpm']]
        : template === 'expo'
          ? [['create', 'expo-app', '.', '--no-install']]
          : template === 't3'
            ? [['dlx', 'create-t3-app@latest', '.', '--default', '--noInstall', '--noGit']]
            : template === 'api'
              ? [
                  [
                    'create',
                    'hono@latest',
                    '.',
                    '--template',
                    'nodejs',
                    '--pm',
                    'pnpm',
                    '--install',
                  ],
                ]
              : [
                  ['create', 'vite', '.', '--template', 'react-ts', '--no-interactive'],
                  ['add', '--ignore-scripts', '@react-three/fiber', '@react-three/drei', 'three'],
                  ['add', '--save-dev', '--ignore-scripts', '@types/three'],
                ];
  const results = [];
  for (const args of commands) {
    const result = await capture(await resolveExecutable('pnpm'), args, root, signal, 300_000);
    results.push({ args, ...result });
    if (result.exitCode !== 0) throw new Error(result.output || `pnpm ${args[0]} failed.`);
  }
  const manifestPath = path.join(root, 'package.json');
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.name = name;
    manifest.packageManager ??= 'pnpm@11.15.1';
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {}
  return { template, name, commands: results, workspace: root };
}

export async function gitInspect(root: string, kind: 'status' | 'diff' | 'log', staged = false) {
  const args =
    kind === 'status'
      ? ['status', '--short', '--branch']
      : kind === 'diff'
        ? ['diff', ...(staged ? ['--cached'] : []), '--stat', '--patch', '--no-ext-diff']
        : ['log', '--oneline', '--decorate', '-20'];
  const result = await capture('/usr/bin/git', args, root, AbortSignal.timeout(30_000), 30_000);
  if (result.exitCode !== 0) throw new Error(result.output || `git ${kind} failed.`);
  return { kind, staged: kind === 'diff' ? staged : undefined, ...result };
}

export async function gitCreateBranch(root: string, branch: string) {
  const checked = gitRef.parse(branch);
  const result = await capture(
    '/usr/bin/git',
    ['switch', '-c', checked],
    root,
    AbortSignal.timeout(30_000),
    30_000,
  );
  if (result.exitCode !== 0) throw new Error(result.output || 'Could not create branch.');
  return { branch: checked, ...result };
}

export async function gitStage(root: string, files: string[]) {
  const resolved = await Promise.all(files.map((file) => safePath(root, file)));
  const relative = resolved.map((file) => path.relative(root, file));
  const result = await capture(
    '/usr/bin/git',
    ['add', '--', ...relative],
    root,
    AbortSignal.timeout(30_000),
    30_000,
  );
  if (result.exitCode !== 0) throw new Error(result.output || 'Could not stage files.');
  return { files: relative, ...result };
}

export async function gitCommit(root: string, message: string) {
  const checked = z.string().trim().min(3).max(200).parse(message);
  const result = await capture(
    '/usr/bin/git',
    ['commit', '-m', checked],
    root,
    AbortSignal.timeout(60_000),
    60_000,
  );
  if (result.exitCode !== 0) throw new Error(result.output || 'Commit failed.');
  return { message: checked, ...result };
}

export async function gitPush(root: string, remote: string, branch: string, signal: AbortSignal) {
  const checkedRemote = z
    .string()
    .regex(/^(?!-)[a-zA-Z0-9._-]+$/)
    .max(100)
    .parse(remote);
  const checkedBranch = gitRef.parse(branch);
  const result = await capture(
    '/usr/bin/git',
    ['push', '-u', checkedRemote, checkedBranch],
    root,
    signal,
    180_000,
  );
  if (result.exitCode !== 0) throw new Error(result.output || 'Push failed.');
  return { remote: checkedRemote, branch: checkedBranch, ...result };
}
