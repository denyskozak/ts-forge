import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
export async function resolveExecutable(name: 'pnpm' | 'docker' | 'node') {
  const directories = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean);
  for (const directory of [...new Set(directories)]) {
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, 1);
      return candidate;
    } catch {}
  }
  throw new Error(`${name} was not found. Install it or add it to PATH before using this tool.`);
}

export function executableEnvironment(executable: string, extra: Record<string, string> = {}) {
  const base = cleanEnvironment(extra);
  return { ...base, PATH: `${path.dirname(executable)}${path.delimiter}${base.PATH}` };
}
export function cleanEnvironment(extra: Record<string, string> = {}) {
  const result: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
    LANG: 'en_US.UTF-8',
    TZ: process.env.TZ ?? 'UTC',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TMPDIR'])
    if (process.env[key]) result[key] = process.env[key];
  return { ...result, ...extra };
}
export function terminate(child: ChildProcess) {
  if (!child.pid) return;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid!, signal);
      else child.kill(signal);
    } catch {}
  };
  kill('SIGTERM');
  const timer = setTimeout(() => kill('SIGKILL'), 2500);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}
export async function sandboxCommand(
  executable: string,
  args: string[],
  readPaths: string[],
  writePaths: string[],
  deniedPaths: string[] = [],
) {
  if (process.platform !== 'darwin')
    throw new Error(
      'Isolated execution is currently supported on macOS only. No unsandboxed fallback is allowed.',
    );
  await fs.access('/usr/bin/sandbox-exec', fs.constants.X_OK);
  const reads = await Promise.all(
    [...readPaths, path.dirname(executable)].map((p) => fs.realpath(p)),
  );
  const writes = await Promise.all(writePaths.map((p) => fs.realpath(p)));
  const quoted = (value: string) => JSON.stringify(value);
  const profile = `(version 1) (deny default) (import "system.sb") (allow process-exec process-fork signal sysctl-read mach-lookup file-read-metadata file-map-executable)
    (allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt/homebrew") (subpath "/Library/Apple") (subpath "/Library/Frameworks") (subpath "/private/var/db") (subpath "/dev") ${reads.map((p) => `(subpath ${quoted(p)})`).join(' ')})
    (allow file-write* (literal "/dev/null") ${writes.map((p) => `(subpath ${quoted(p)})`).join(' ')})
    (deny network*)
    ${deniedPaths.length ? `(deny file-read-data ${deniedPaths.map((p) => `(subpath ${quoted(p)})`).join(' ')})` : ''}
    (deny file-read-data (regex #"(^|/)(\\.env([^/]*)?|\\.npmrc|id_rsa|id_ed25519|credentials[^/]*|secrets?[^/]*)(/|$)") (regex #"\\.(pem|key|p12|pfx)$"))`;
  return { executable: '/usr/bin/sandbox-exec', args: ['-p', profile, executable, ...args] };
}
export async function executeResult(
  executable: string,
  args: string[],
  root: string,
  signal: AbortSignal,
  readPaths: string[],
  writePaths: string[],
  extra: Record<string, string> = {},
  deniedPaths: string[] = [],
) {
  const command = await sandboxCommand(executable, args, readPaths, writePaths, deniedPaths);
  signal.throwIfAborted();
  return new Promise<{
    exitCode: number | null;
    signal: string | null;
    output: string;
    timedOut: boolean;
    cancelled: boolean;
  }>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: root,
      detached: true,
      env: cleanEnvironment(extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-24000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const stop = () => terminate(child);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, 90000);
    child.on('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      reject(error);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve({
        exitCode: code,
        signal: sig,
        output: output || 'No diagnostics.',
        timedOut,
        cancelled: signal.aborted,
      });
    });
  });
}

export async function execute(...args: Parameters<typeof executeResult>) {
  const result = await executeResult(...args);
  return `Exit code: ${result.exitCode}; signal: ${result.signal ?? 'none'}\n${result.output}`;
}
