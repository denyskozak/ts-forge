/** Read-only review probes. Assertions document current gaps, not desired behavior. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { initialRunView, runViewReducer } from '../src/state/run-view';
import { DEFAULT_SETTINGS, type AppState, type Session } from '../shared/types';
import { languageQuery } from '../electron/analysis-engine';
const session: Session = {
  id: 'fixture',
  title: 'Fixture',
  workspace: '/fixture',
  messages: [],
  changes: [],
  updatedAt: 1,
};
const stale: AppState = {
  settings: DEFAULT_SETTINGS,
  workspace: null,
  sessions: [session],
  examples: [],
  platform: 'fixture',
  dataPath: '/fixture',
  activeRun: {
    id: 'run',
    sessionId: session.id,
    workspace: session.workspace,
    status: 'waiting',
    label: 'Waiting',
    approval: { id: 'approval', kind: 'typecheck', title: 'Old approval' },
  },
};
const completed = runViewReducer(initialRunView, { type: 'done', session });
const lateHydration = runViewReducer(completed, { type: 'hydrate', data: stale });
assert.equal(lateHydration.busy, true);
assert.equal(lateHydration.approval?.id, 'approval');
const references = languageQuery({
  files: [{ path: 'main.ts', source: 'export const value=1;\n' + 'value;\n'.repeat(100) }],
  query: { kind: 'references', path: 'main.ts', line: 1, character: 14 },
}) as { matches: unknown[]; complete?: boolean };
assert.equal(references.matches.length, 80);
assert.equal(references.complete, undefined);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-review-'));
let codes: number[] = [];
try {
  const file = path.join(temp, 'fixture.ts');
  const source =
    'export function sum(values: number[]): number { const invalid: number = "wrong"; return values.reduce((a,b)=>a+b,0); }';
  await fs.writeFile(file, source);
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  codes = ts.getPreEmitDiagnostics(program).map((d) => d.code);
  assert.ok(codes.includes(2322));
  const javascript = ts.transpile(source, { module: ts.ModuleKind.CommonJS });
  assert.ok(javascript.includes('"wrong"'));
  assert.ok(!javascript.includes(': number'));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
const report = {
  createdAt: new Date().toISOString(),
  scope: 'Synthetic probes; no user files, model inference or production state were modified.',
  observations: [
    {
      id: 'R01',
      confirmed: true,
      result:
        'A stale waiting snapshot delivered after done makes the reducer busy and restores an obsolete approval.',
    },
    {
      id: 'R02',
      confirmed: true,
      result:
        'A TypeScript source containing TS2322 is transpiled into executable JS; the evaluator has no separate typecheck.',
      diagnosticCodes: codes,
    },
    {
      id: 'R03',
      confirmed: true,
      result: '101 source references yield 80 matches with no completeness flag.',
      returned: references.matches.length,
    },
  ],
};
await fs.writeFile('docs/review-observations.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
