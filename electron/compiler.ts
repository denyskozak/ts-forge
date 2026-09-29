import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
// The release keeps compiler resources outside ASAR so packaging retains declaration files.
export function compilerDirectory() {
  const packaged = typeof __dirname === 'string' ? path.resolve(__dirname, '../../compiler') : '';
  return packaged && existsSync(path.join(packaged, 'lib/lib.es2022.full.d.ts'))
    ? packaged
    : path.dirname(path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 })));
}
