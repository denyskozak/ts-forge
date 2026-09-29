import { build } from 'tsup';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import electron from 'electron';
await build({
  entry: ['electron/main.ts', 'electron/preload.ts', 'electron/analysis-worker.ts'],
  format: ['cjs'],
  removeNodeProtocol: false,
  outDir: 'dist-electron',
  external: ['electron'],
  splitting: false,
  clean: true,
  outExtension: () => ({ js: '.js' }),
});
await writeFile('dist-electron/package.json', '{"type":"commonjs"}');
const server = await createServer();
await server.listen();
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, FORGE_DEV_URL: 'http://127.0.0.1:5187' },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
