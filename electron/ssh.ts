import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { z } from 'zod';
import { safePath } from './workspace';
import type { SshProfile } from '../shared/types';

export const sshProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(253).regex(/^(?!-)[a-zA-Z0-9._-]+$/),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  auth: z.enum(['system', 'key']),
  keyPath: z.string().max(4000).default(''),
});

const remotePathSchema = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^\/[a-zA-Z0-9._/-]+$/)
  .refine((value) => !value.split('/').includes('..'), 'Remote path cannot contain ..');

function connectionArgs(profile: SshProfile) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes',
    '-p', String(profile.port),
  ];
  if (profile.auth === 'key') {
    if (!profile.keyPath) throw new Error('This SSH profile has no private key path.');
    args.push('-F', '/dev/null', '-o', 'IdentitiesOnly=yes', '-i', profile.keyPath);
  }
  args.push(`${profile.user}@${profile.host}`);
  return args;
}

function environment() {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: homedir(),
    LANG: 'en_US.UTF-8',
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
  };
}

async function execute(file: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
    const child = spawn(file, args, { env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer) => { output = (output + chunk).slice(-24_000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const stop = () => child.kill('SIGTERM');
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 30_000);
    child.on('error', reject);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve({ exitCode, output: output.trim() });
    });
  });
}

async function validateProfile(profile: SshProfile) {
  const parsed = sshProfileSchema.parse(profile);
  if (parsed.auth === 'key') {
    const resolved = await fs.realpath(parsed.keyPath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error('SSH key path is not a regular file.');
    return { ...parsed, keyPath: resolved };
  }
  return parsed;
}

export async function testSsh(profile: SshProfile, signal: AbortSignal) {
  const checked = await validateProfile(profile);
  const started = Date.now();
  const result = await execute('/usr/bin/ssh', [...connectionArgs(checked), 'printf FORGE_SSH_OK'], signal);
  return { ok: result.exitCode === 0 && result.output.includes('FORGE_SSH_OK'), latencyMs: Date.now() - started, ...result };
}

export async function listRemote(profile: SshProfile, remotePath: string, signal: AbortSignal) {
  const checked = await validateProfile(profile);
  const target = remotePathSchema.parse(remotePath);
  const result = await execute('/usr/bin/ssh', [...connectionArgs(checked), `ls -la -- '${target}'`], signal);
  if (result.exitCode !== 0) throw new Error(result.output || `SSH exited with ${result.exitCode}.`);
  return { path: target, ...result };
}

export async function uploadSsh(
  root: string,
  profile: SshProfile,
  localPaths: string[],
  remoteDirectory: string,
  signal: AbortSignal,
) {
  const checked = await validateProfile(profile);
  const parsedDestination = remotePathSchema.parse(remoteDirectory);
  const destination = parsedDestination === '/' ? '/' : parsedDestination.replace(/\/$/, '');
  const sources = await Promise.all(localPaths.map((file) => safePath(root, file)));
  for (const source of sources) if (!(await fs.stat(source)).isFile()) throw new Error('SSH upload supports regular files only.');
  const args = ['-B', '-P', String(checked.port), '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes'];
  if (checked.auth === 'key') args.push('-F', '/dev/null', '-o', 'IdentitiesOnly=yes', '-i', checked.keyPath);
  args.push('--', ...sources, `${checked.user}@${checked.host}:${destination}/`);
  const result = await execute('/usr/bin/scp', args, signal);
  if (result.exitCode !== 0) throw new Error(result.output || `SCP exited with ${result.exitCode}.`);
  return { uploaded: localPaths, remoteDirectory: destination, ...result };
}
