import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../electron/store';
import { applyChangeSet, createChangeSet, undoChangeSet } from '../electron/change-sets';
import { recoverInterrupted } from '../electron/changes';
import { createAnalysisEngine } from '../electron/analysis-engine';
import {
  queryTypes,
  analyzeImpact,
  closeAnalysis,
  invalidateAnalysis,
} from '../electron/language-tools';
import { runValidation, workspaceFingerprint, resolveRecipe } from '../electron/validation';
import { taskOutcome, type TaskRecord } from '../shared/task';
import type { Change } from '../shared/types';
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workflow-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  const store = new Store(path.join(directory, 'state'));
  await store.load();
  const session = {
    id: randomUUID(),
    title: 'Feature',
    workspace: root,
    messages: [],
    changes: [] as Change[],
    updatedAt: 0,
  };
  store.value.sessions.push(session);
  t.after(async () => {
    closeAnalysis(root);
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, store, session };
}
function edit(
  root: string,
  sessionId: string,
  file: string,
  before: string,
  after: string,
  existed = true,
): Change {
  return {
    id: randomUUID(),
    workspace: root,
    sessionId,
    path: file,
    before,
    after,
    existed,
    status: 'pending',
  };
}
const signal = () => new AbortController().signal;
test('multi-file apply preflights every file and group undo preserves intervening edits', async (t) => {
  const { root, store, session } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.ts'), 'old-a');
  await fs.writeFile(path.join(root, 'b.ts'), 'old-b');
  const set = createChangeSet(
    session,
    'run',
    [
      edit(root, session.id, 'a.ts', 'old-a', 'new-a'),
      edit(root, session.id, 'b.ts', 'old-b', 'new-b'),
    ],
    'two files',
  );
  await fs.writeFile(path.join(root, 'b.ts'), 'user-b');
  await assert.rejects(applyChangeSet(store, set, signal()), /Stale version/);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'old-a');
  await fs.writeFile(path.join(root, 'b.ts'), 'old-b');
  await applyChangeSet(store, set, signal());
  assert.equal(set.status, 'applied');
  await fs.writeFile(path.join(root, 'b.ts'), 'user-b');
  await assert.rejects(undoChangeSet(store, set.id), /Stale version/);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'new-a');
  await fs.writeFile(path.join(root, 'b.ts'), 'new-b');
  await undoChangeSet(store, set.id);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'old-a');
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'old-b');
});
test('failure after first write rolls the entire changeset back including newly created files', async (t) => {
  const { root, store, session } = await fixture(t);
  await fs.writeFile(path.join(root, 'b.ts'), 'old');
  const set = createChangeSet(
    session,
    'run',
    [
      edit(root, session.id, 'a.ts', '', 'new', false),
      edit(root, session.id, 'b.ts', 'old', 'new'),
    ],
    'new and existing',
  );
  await assert.rejects(
    applyChangeSet(store, set, signal(), async () => {
      throw new Error('Injected write failure');
    }),
    /Injected/,
  );
  assert.equal(set.status, 'rolled_back');
  await assert.rejects(fs.stat(path.join(root, 'a.ts')));
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'old');
});
test('rollback preserves a concurrent editor change and reports conflict', async (t) => {
  const { root, store, session } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.ts'), 'old');
  const set = createChangeSet(
    session,
    'run',
    [edit(root, session.id, 'a.ts', 'old', 'new')],
    'edit',
  );
  await assert.rejects(
    applyChangeSet(store, set, signal(), async () => {
      await fs.writeFile(path.join(root, 'a.ts'), 'editor');
      throw new Error('Injected');
    }),
  );
  assert.equal(set.status, 'conflict');
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'editor');
});
test('restart recovery rolls back an interrupted transaction without applying unfinished files', async (t) => {
  const { root, store, session } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.ts'), 'new');
  await fs.writeFile(path.join(root, 'b.ts'), 'old');
  const set = createChangeSet(
    session,
    'run',
    [edit(root, session.id, 'a.ts', 'old', 'new'), edit(root, session.id, 'b.ts', 'old', 'new')],
    'interrupted',
  );
  set.status = 'applying';
  session.changes.forEach((c) => {
    c.status = 'applying';
  });
  await store.save();
  await recoverInterrupted(store);
  assert.equal(set.status, 'rolled_back');
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'old');
});
test('changesets reject duplicate normalized paths', async (t) => {
  const { root, session } = await fixture(t);
  assert.throws(
    () =>
      createChangeSet(
        session,
        'run',
        [edit(root, session.id, 'a.ts', '', 'a'), edit(root, session.id, './a.ts', '', 'b')],
        'duplicate',
      ),
    /Duplicate/,
  );
});
test('verified outcome requires current checks, applied edits and explicit acceptance', () => {
  const task: TaskRecord = {
    runId: 'r',
    goal: 'feature',
    constraints: [],
    outOfScope: [],
    criteria: [{ id: 'c', description: 'works', acceptedFingerprint: 'current' }],
    requiredChecks: [{ recipe: 'typescript.check', project: 'tsconfig.json', files: [] }],
    validations: [
      {
        id: 'v',
        recipe: 'typescript.check',
        project: 'tsconfig.json',
        files: [],
        fingerprint: 'current',
        startedAt: 0,
        durationMs: 1,
        status: 'passed',
        exitCode: 0,
        output: '',
      },
    ],
    fingerprint: 'current',
    appliedChanges: 2,
    outcome: 'in_progress',
  };
  assert.equal(taskOutcome(task), 'completed_verified');
  assert.equal(taskOutcome({ ...task, fingerprint: 'changed' }), 'completed_unverified');
  assert.equal(taskOutcome({ ...task, appliedChanges: 0 }), 'completed_unverified');
  assert.equal(
    taskOutcome({ ...task, criteria: [{ id: 'c', description: 'works' }] }),
    'completed_unverified',
  );
  task.validations.push({ ...task.validations[0], status: 'failed' });
  assert.equal(taskOutcome(task), 'completed_unverified');
});
test('persistent engine reuses unchanged sources and updates diagnostics after one file changes', () => {
  const engine = createAnalysisEngine();
  try {
    const files = [{ path: 'a.ts', source: 'export const value: number = "bad";' }];
    const query = { kind: 'diagnostics' as const, path: 'a.ts', line: 1, character: 1 };
    const first = engine.query({ files, query }) as {
      diagnostics: { code: number }[];
      generation: number;
      updatedFiles: number;
    };
    assert.ok(first.diagnostics.some((d) => d.code === 2322));
    const second = engine.query({ files, query }) as typeof first;
    assert.equal(second.updatedFiles, 0);
    assert.equal(second.generation, first.generation);
    const third = engine.query({
      files: [{ path: 'a.ts', source: 'export const value: number = 2;' }],
      query,
    }) as typeof first;
    assert.equal(third.updatedFiles, 1);
    assert.equal(third.diagnostics.length, 0);
  } finally {
    engine.dispose();
  }
});
test('references paginate beyond 80 and expose partial snapshot metadata', () => {
  const engine = createAnalysisEngine();
  try {
    const files = [
      {
        path: 'a.ts',
        source:
          'export const value = 1;\n' +
          Array.from({ length: 100 }, (_, i) => `const x${i} = value;`).join('\n'),
      },
    ];
    const query = { kind: 'references' as const, path: 'a.ts', line: 1, character: 14 };
    const result = engine.query({ files, query, complete: false, skipped: 5 }) as {
      matches: unknown[];
      nextOffset: number;
      total: number;
      snapshotComplete: boolean;
    };
    assert.equal(result.matches.length, 80);
    assert.equal(result.total, 101);
    assert.equal(result.snapshotComplete, false);
    const more = engine.query({ files, query: { ...query, offset: result.nextOffset } }) as {
      matches: unknown[];
      nextOffset: null;
    };
    assert.equal(more.matches.length, 21);
    assert.equal(more.nextOffset, null);
  } finally {
    engine.dispose();
  }
});
test('impact resolves tsconfig aliases, transitive consumers, tests and changed exports', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] }, strict: false },
      include: ['src'],
    }),
  );
  await fs.writeFile(path.join(root, 'src/value.ts'), 'export const value = 1;');
  await fs.writeFile(
    path.join(root, 'src/view.ts'),
    "import { value } from '@/value'; export const view = () => value;",
  );
  await fs.writeFile(path.join(root, 'src/view.test.ts'), "import { view } from './view'; view();");
  const result = await analyzeImpact(root, ['src/value.ts'], signal());
  assert.deepEqual(result.affected, ['src/value.ts', 'src/view.test.ts', 'src/view.ts']);
  assert.deepEqual(result.tests, ['src/view.test.ts']);
  assert.equal(result.exports[0].name, 'value');
  assert.ok(result.edges.some((edge) => edge.from === 'src/view.ts' && edge.to === 'src/value.ts'));
  assert.equal(result.complete, false);
});
test('workspace service invalidates cached files and handles deletion', async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.ts'), 'export const value = 1;');
  const query = { kind: 'quick_info' as const, path: 'a.ts', line: 1, character: 14 };
  const first = (await queryTypes(root, query, signal())) as { display: string };
  assert.match(first.display, /1/);
  await fs.writeFile(path.join(root, 'a.ts'), 'export const value = "new";');
  invalidateAnalysis(root);
  const next = (await queryTypes(root, query, signal())) as { display: string };
  assert.match(next.display, /new/);
  await fs.unlink(path.join(root, 'a.ts'));
  invalidateAnalysis(root);
  await assert.rejects(queryTypes(root, query, signal()));
});
test(
  'validation receipt detects TypeScript errors and binds success to source version',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const { root, directory } = await fixture(t);
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true }, include: ['a.ts'] }),
    );
    await fs.writeFile(path.join(root, 'a.ts'), 'export const value: number = "bad";');
    const check = { recipe: 'typescript.check' as const, project: 'tsconfig.json', files: [] };
    const failed = await runValidation(root, directory, check, signal());
    assert.equal(failed.status, 'failed', failed.output);
    assert.notEqual(failed.exitCode, 0);
    await fs.writeFile(path.join(root, 'a.ts'), 'export const value: number = 1;');
    const passed = await runValidation(root, directory, check, signal());
    assert.equal(passed.status, 'passed', passed.output);
    assert.equal(passed.fingerprint, await workspaceFingerprint(root));
    assert.notEqual(failed.fingerprint, passed.fingerprint);
    assert.deepEqual((await fs.readdir(root)).sort(), ['a.ts', 'tsconfig.json']);
  },
);
test(
  'Node test recipe blocks original workspace writes and network while allowing snapshot output',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const { root, directory } = await fixture(t);
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await fs.writeFile(
      path.join(root, 'a.test.cjs'),
      `const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); test('isolation', async () => { assert.throws(() => fs.writeFileSync(${JSON.stringify(path.join(root, 'escape.txt'))}, 'bad')); fs.writeFileSync('snapshot-output.txt', 'ok'); await assert.rejects(fetch('http://127.0.0.1:9')); });`,
    );
    const result = await runValidation(
      root,
      directory,
      { recipe: 'tests.related', project: 'tsconfig.json', files: ['a.test.cjs'] },
      signal(),
    );
    assert.equal(result.status, 'passed', result.output);
    await assert.rejects(fs.stat(path.join(root, 'escape.txt')));
    await assert.rejects(fs.stat(path.join(root, 'snapshot-output.txt')));
  },
);
test('missing validators fail closed and paths cannot escape the workspace', async (t) => {
  const { root, directory } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.ts'), 'export {};');
  const result = await runValidation(
    root,
    directory,
    { recipe: 'next.build', project: 'tsconfig.json', files: [] },
    signal(),
  );
  assert.equal(result.status, 'unavailable');
  await assert.rejects(
    resolveRecipe(root, directory, directory, {
      recipe: 'lint.files',
      project: 'tsconfig.json',
      files: ['../outside'],
    }),
    /outside/,
  );
});

test('changeset rejects UTF-8 content exceeding reversible read limits', async (t) => {
  const { root, session } = await fixture(t);
  assert.throws(
    () =>
      createChangeSet(
        session,
        'run',
        [edit(root, session.id, 'large.ts', '', 'я'.repeat(100001), false)],
        'oversized',
      ),
    /200 KB/,
  );
  assert.equal(session.changes.length, 0);
});
