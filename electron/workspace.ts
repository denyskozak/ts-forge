import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import ignore from 'ignore';
const IGNORED = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  '.forge',
  'playwright-report',
  'test-results',
  'vendor',
  '.ssh',
  '.aws',
  '.gnupg',
  '.venv',
  'venv',
]);
const SECRET =
  /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|id_rsa|id_ed25519|credentials(?:\..*)?|secrets?(?:\..*)?)$|\.(pem|key|p12|pfx)$/i;
export function isPrivate(relative: string) {
  return SECRET.test(relative.replaceAll('\\', '/'));
}
export function hash(text: string) {
  return createHash('sha256').update(text).digest('hex');
}
class Policy {
  private rules = new Map<string, ReturnType<typeof ignore>[]>();
  constructor(readonly root: string) {}
  async denied(relative: string, directory = false) {
    const rel = relative.replaceAll(path.sep, '/');
    if (isPrivate(rel) || rel.split('/').some((p) => IGNORED.has(p))) return true;
    const components = rel.split('/');
    for (let depth = 0; depth < components.length; depth++) {
      const base = components.slice(0, depth).join('/');
      let rules = this.rules.get(base);
      if (!rules) {
        rules = [];
        for (const name of ['.gitignore', '.forgeignore']) {
          const target = path.join(this.root, base, name);
          try {
            const stat = await fs.lstat(target);
            if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 100000)
              rules.push(ignore().add(await fs.readFile(target, 'utf8')));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
        this.rules.set(base, rules);
      }
      const local = components.slice(depth).join('/') + (directory ? '/' : '');
      if (rules.some((rule) => rule.ignores(local))) return true;
    }
    return false;
  }
}
export async function safePath(root: string, relative: string, write = false): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0'))
    throw new Error('Use a relative workspace path.');
  const canonicalRoot = await fs.realpath(root),
    target = path.resolve(canonicalRoot, relative),
    rel = path.relative(canonicalRoot, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error('Path is outside the allowed workspace or is protected.');
  let current = target;
  while (current !== canonicalRoot) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error('Symbolic links are not accessible.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !write) throw e;
    }
    current = path.dirname(current);
  }
  if (await new Policy(canonicalRoot).denied(rel))
    throw new Error('Path is protected or excluded by .gitignore/.forgeignore.');
  return target;
}
export async function readText(root: string, relative: string) {
  const target = await safePath(root, relative);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 200000)
      throw new Error('Only text files under 200 KB can be read.');
    const text = await handle.readFile('utf8');
    if (text.includes('\0')) throw new Error('Binary files are not supported.');
    return text;
  } finally {
    await handle.close();
  }
}
export async function readRange(root: string, relative: string, offset = 0, limit = 12000) {
  const text = await readText(root, relative),
    end = Math.min(text.length, offset + limit);
  if (offset > text.length) throw new Error('Offset exceeds file length.');
  return {
    path: relative,
    hash: hash(text),
    offset,
    end,
    totalCharacters: text.length,
    totalLines: text.split('\n').length,
    truncated: end < text.length || offset > 0,
    nextOffset: end < text.length ? end : null,
    content: text.slice(offset, end),
  };
}
export async function scanFiles(root: string, max = 10000, signal?: AbortSignal) {
  const canonical = await fs.realpath(root),
    policy = new Policy(canonical),
    files: string[] = [];
  let complete = true;
  const warnings: string[] = [];
  async function walk(dir: string, depth: number) {
    signal?.throwIfAborted();
    if (depth > 24) {
      complete = false;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(path.join(canonical, dir), { withFileTypes: true });
    } catch (e) {
      warnings.push(`${dir}: ${(e as Error).message}`);
      complete = false;
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (files.length >= max) {
        complete = false;
        return;
      }
      const relative = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || (await policy.denied(relative, entry.isDirectory()))) continue;
      if (entry.isDirectory()) await walk(relative, depth + 1);
      else if (entry.isFile()) files.push(relative);
    }
  }
  await walk('', 0);
  return { files, complete, warnings };
}
export async function listFiles(root: string, max = 1600) {
  return (await scanFiles(root, max)).files;
}
export async function applyChange(
  root: string,
  relative: string,
  before: string,
  after: string,
  existed?: boolean,
) {
  const target = await safePath(root, relative, true);
  let actual = '',
    exists = false,
    mode = 0o600;
  try {
    actual = await readText(root, relative);
    exists = true;
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (actual !== before || (existed !== undefined && exists !== existed))
    throw new Error('The file changed since review. Ask the agent to read it again.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await safePath(root, relative, true);
  const temporary = path.join(path.dirname(target), `.forge-write-${randomUUID()}`);
  try {
    const file = await fs.open(temporary, 'wx', mode);
    try {
      await file.writeFile(after);
      await file.sync();
    } finally {
      await file.close();
    }
    let latest = '';
    let stillExists = false;
    try {
      latest = await readText(root, relative);
      stillExists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (latest !== before || stillExists !== exists)
      throw new Error('The file changed since review. Ask the agent to read it again.');
    await safePath(root, relative, true);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
export async function removeCreatedFile(root: string, relative: string, expected: string) {
  const target = await safePath(root, relative);
  if ((await readText(root, relative)) !== expected)
    throw new Error('File changed after the agent edit. Undo would overwrite your work.');
  await fs.unlink(target);
}
export function replaceExact(text: string, oldText: string, newText: string) {
  const first = text.indexOf(oldText);
  if (!oldText || first < 0 || text.indexOf(oldText, first + oldText.length) >= 0)
    throw new Error(
      'Expected text must match exactly once. Read the file and use a unique fragment.',
    );
  return text.slice(0, first) + newText + text.slice(first + oldText.length);
}
/** Denied paths for project executors. Dependencies remain readable for the compiler. */
export async function executionDeniedPaths(root: string) {
  const canonical = await fs.realpath(root),
    policy = new Policy(canonical),
    denied: string[] = [];
  let visited = 0;
  async function walk(dir: string, depth: number) {
    if (depth > 24 || visited > 20000)
      throw new Error('Cannot establish executor file policy within the scan limit.');
    for (const entry of await fs.readdir(path.join(canonical, dir), { withFileTypes: true })) {
      visited++;
      const relative = path.join(dir, entry.name);
      if (entry.name === 'node_modules') continue;
      if ((await policy.denied(relative, entry.isDirectory())) || entry.isSymbolicLink()) {
        denied.push(path.join(canonical, relative));
        continue;
      }
      if (entry.isDirectory()) await walk(relative, depth + 1);
    }
  }
  await walk('', 0);
  return denied;
}
