import test from 'node:test';
import assert from 'node:assert/strict';
import { selectUnderstandingFiles } from '../electron/mental-model';
import { buildMentalModel } from '../electron/mental-model';
import { describeSource } from '../electron/project-map';
import type { ProjectEntry } from '../shared/types';

test('explicit architecture paths are included before broad entrypoint traversal fills the budget', () => {
  const entry = (path: string): ProjectEntry => ({
    path,
    hash: 'fixture',
    bytes: 24,
    lines: 1,
    ...describeSource(path, 'export const value = 1;'),
  });
  const entries = [
    ...Array.from({ length: 12 }, (_, index) => entry(`packages/${index}/main.ts`)),
    entry('electron/preload.ts'),
    entry('electron/agent.ts'),
    entry('src/App.tsx'),
  ];
  const model = buildMentalModel(
    entries,
    entries.map((item) => item.path),
    {},
  );
  const selected = selectUnderstandingFiles(
    model,
    entries,
    'Understand electron/preload.ts, electron/agent.ts and src/App.tsx',
    8,
  );
  for (const path of ['electron/preload.ts', 'electron/agent.ts', 'src/App.tsx'])
    assert.ok(selected.includes(path));
  assert.equal(selected.length, 8);
});
