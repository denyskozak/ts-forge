import { build } from 'tsup';
import { writeFile } from 'node:fs/promises';
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
