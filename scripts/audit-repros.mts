// The v0.1 reproductions asserted known bugs. Their replacements assert safe behavior.
import { spawnSync } from 'node:child_process';
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', 'tests/hardening.test.ts'],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
