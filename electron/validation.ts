import { promises as fs, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkSchema, type ValidationCheck, type ValidationResult } from '../shared/task';
import { readText, scanFiles, safePath, hash } from './workspace';
import { compilerDirectory } from './compiler';
import { executeResult } from './executor';
export async function captureWorkspace(root: string, signal?: AbortSignal) {
  const scan = await scanFiles(root, 10000, signal);
  if (!scan.complete) throw new Error('Validation requires a complete workspace scan.');
  const files: { path: string; content: Buffer }[] = [];
  let bytes = 0;
  for (const filename of scan.files) {
    signal?.throwIfAborted();
    try {
      const handle = await fs.open(
        await safePath(root, filename),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let content: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 10_000_000)
          throw new Error('Snapshot file exceeds 10 MB or is not regular.');
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
      bytes += content.length;
      if (bytes > 64_000_000) throw new Error('Validation snapshot exceeds 64 MB.');
      files.push({ path: filename, content });
    } catch (error) {
      // Do not quietly validate an incomplete copy, including binary assets.
      throw new Error(`Cannot snapshot ${filename}: ${(error as Error).message}`);
    }
  }
  return {
    files,
    fingerprint: hash(
      JSON.stringify(
        files.map((f) => [f.path, createHash('sha256').update(f.content).digest('hex')]),
      ),
    ),
  };
}
export async function workspaceFingerprint(root: string, signal?: AbortSignal) {
  return (await captureWorkspace(root, signal)).fingerprint;
}
async function installedBin(root: string, packageName: string, executable: string) {
  const modules = await fs.realpath(path.join(root, 'node_modules'));
  if (modules !== path.join(await fs.realpath(root), 'node_modules'))
    throw new Error('External node_modules symlink is not supported.');
  const target = await fs.realpath(path.join(modules, packageName, executable));
  if (!target.startsWith(modules + path.sep))
    throw new Error('Validator escapes installed dependencies.');
  return { target, modules };
}
export async function resolveRecipe(
  root: string,
  snapshot: string,
  scratch: string,
  input: ValidationCheck,
) {
  const check = checkSchema.parse(input);
  for (const file of check.files) await safePath(root, file);
  const local = async (pkg: string, bin: string, args: string[]) => {
    const found = await installedBin(root, pkg, bin);
    return { args: [found.target, ...args], reads: [found.modules] };
  };
  if (check.recipe === 'typescript.check') {
    await safePath(root, check.project);
    return {
      args: [
        path.join(compilerDirectory(), 'bin/tsc'),
        '--project',
        path.join(snapshot, check.project),
        '--noEmit',
        '--pretty',
        'false',
        '--incremental',
        '--tsBuildInfoFile',
        path.join(scratch, 'check.tsbuildinfo'),
      ],
      reads: [compilerDirectory()],
    };
  }
  if (check.recipe === 'tests.related' || check.recipe === 'tests.project') {
    const manifest = JSON.parse(await readText(root, 'package.json'));
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    if (check.recipe === 'tests.related' && !check.files.length)
      throw new Error('Related tests require explicit source or test paths.');
    if (dependencies.vitest)
      return local(
        'vitest',
        'vitest.mjs',
        check.recipe === 'tests.related' ? ['related', '--run', '--', ...check.files] : ['run'],
      );
    if (dependencies.jest)
      return local('jest', 'bin/jest.js', [
        '--runInBand',
        ...(check.recipe === 'tests.related' ? ['--findRelatedTests', '--', ...check.files] : []),
      ]);
    const tests = check.files.filter((f) => /\.(test|spec)\.[cm]?js$/.test(f));
    if (check.recipe === 'tests.related' && tests.length === check.files.length && tests.length)
      return { args: ['--test', ...tests.map((f) => path.join(snapshot, f))], reads: [] };
    throw new Error(
      'Install Vitest/Jest, or select explicit Node .test.js/.spec.js files. No dependency downloads are performed.',
    );
  }
  if (check.recipe === 'lint.files') {
    if (!check.files.length) throw new Error('Lint requires explicit files.');
    return local('eslint', 'bin/eslint.js', ['--', ...check.files]);
  }
  if (check.recipe === 'format.check') {
    if (!check.files.length) throw new Error('Format check requires explicit files.');
    return local('prettier', 'bin/prettier.cjs', ['--check', '--', ...check.files]);
  }
  if (check.recipe === 'next.build') return local('next', 'dist/bin/next', ['build']);
  if (check.recipe === 'expo.doctor') return local('expo-doctor', 'build/index.js', []);
  return { args: [], reads: [] };
}
async function checkExports(root: string, snapshot: string) {
  const manifest = JSON.parse(await readText(root, 'package.json'));
  const entries: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') entries.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(manifest.exports ?? manifest.main);
  if (!entries.length) throw new Error('No package exports or main entry declared.');
  for (const entry of entries) {
    if (entry.includes('*'))
      throw new Error(
        'Pattern exports need a dedicated package fixture; cannot verify automatically.',
      );
    const relative = entry.replace(/^\.\//, '');
    await safePath(root, relative);
    await fs.access(path.join(snapshot, relative));
  }
  return `${entries.length} package entry points exist in the snapshot.`;
}
export async function runValidation(
  root: string,
  dataPath: string,
  input: ValidationCheck,
  signal: AbortSignal,
): Promise<ValidationResult> {
  const check = checkSchema.parse(input),
    startedAt = Date.now();
  const result: ValidationResult = {
    ...check,
    id: randomUUID(),
    fingerprint: '',
    startedAt,
    durationMs: 0,
    status: 'unavailable',
    exitCode: null,
    output: '',
  };
  let scratch: string | undefined;
  try {
    signal.throwIfAborted();
    const captured = await captureWorkspace(root, signal);
    result.fingerprint = captured.fingerprint;
    const base = path.join(dataPath, 'validation');
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    scratch = await fs.mkdtemp(path.join(base, 'run-'));
    const snapshot = path.join(scratch, 'project');
    await fs.mkdir(snapshot);
    for (const file of captured.files) {
      const dest = path.join(snapshot, file.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.content, { mode: 0o600 });
    }
    const recipe = await resolveRecipe(root, snapshot, scratch, check);
    const modules = path.join(await fs.realpath(root), 'node_modules');
    if (
      await fs
        .lstat(modules)
        .then((s) => s.isDirectory())
        .catch(() => false)
    ) {
      // Dependencies are shared read-only; generated output remains inside the disposable snapshot.
      await fs.symlink(modules, path.join(snapshot, 'node_modules'));
      recipe.reads.push(modules);
    }
    if (check.recipe === 'package.exports.check') {
      result.output = await checkExports(root, snapshot);
      result.exitCode = 0;
      result.status = 'passed';
    } else {
      const execution = await executeResult(
        process.execPath,
        recipe.args,
        snapshot,
        signal,
        [snapshot, ...recipe.reads, path.resolve(path.dirname(process.execPath), '..')],
        [scratch],
        {
          ELECTRON_RUN_AS_NODE: '1',
          HOME: scratch,
          TMPDIR: scratch,
          CI: '1',
          NEXT_TELEMETRY_DISABLED: '1',
          EXPO_NO_TELEMETRY: '1',
          EXPO_OFFLINE: '1',
        },
      );
      result.exitCode = execution.exitCode;
      result.output = `Exit code: ${execution.exitCode}; signal: ${execution.signal ?? 'none'}\n${execution.output}`;
      result.status = execution.cancelled
        ? 'cancelled'
        : execution.timedOut || execution.exitCode !== 0
          ? 'failed'
          : 'passed';
    }
    if ((await workspaceFingerprint(root, signal)) !== captured.fingerprint)
      result.status = 'stale';
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : 'unavailable';
    result.output = (error as Error).message;
  } finally {
    result.durationMs = Date.now() - startedAt;
    if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}
