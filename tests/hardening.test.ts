import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { Store } from '../electron/store';
import { Agent } from '../electron/agent';
import { chat, testConnection } from '../electron/provider';
import {
  hash,
  readRange,
  readText,
  replaceExact,
  scanFiles,
  safePath,
} from '../electron/workspace';
import { commitChange, undoChange, recoverInterrupted } from '../electron/changes';
import { analyzeProject, renderMap } from '../electron/project-map';
import { budgetMessages } from '../electron/context';
import { execute, cleanEnvironment } from '../electron/executor';
import { splitDataset } from '../electron/training';
import {
  buildMentalModel,
  inspectMentalModel,
  selectUnderstandingFiles,
} from '../electron/mental-model';
import { recoverReadOnlyToolCall } from '../electron/tool-recovery';
import { analyzeTypeScriptProject } from '../electron/typescript-project-analysis';
import type { Change, AgentEvent, ProjectEntry } from '../shared/types';
async function fixture() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'forge-hardening-'));
}
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
test('SQLite refuses stale writer instead of losing examples', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const a = new Store(dir),
    b = new Store(dir);
  await a.load();
  await b.load();
  a.value.examples.push({ id: 'e', prompt: 'p', response: 'r', createdAt: 0 });
  await a.save();
  b.value.settings.model = 'stale';
  await assert.rejects(b.save(), /Another writer/);
  const c = new Store(dir);
  await c.load();
  assert.equal(c.value.examples.length, 1);
});
test('migration preserves damaged original and recovers valid sections', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({
      sessions: null,
      examples: [{ id: 'e', prompt: 'p', response: 'r', createdAt: 0 }],
    }),
  );
  const store = new Store(dir);
  await store.load();
  assert.deepEqual(store.value.sessions, []);
  assert.equal(store.value.examples.length, 1);
  assert.ok(store.recovery.length);
  assert.ok((await fs.readdir(dir)).some((f) => f.startsWith('state-legacy-')));
});
test('ignore rules cover listing, direct reads and writes, including nested policy', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, '.forgeignore'), 'private.txt\n');
  await fs.writeFile(path.join(dir, 'private.txt'), 'fixture');
  await fs.writeFile(path.join(dir, 'src/.gitignore'), 'hidden.ts\n');
  await fs.writeFile(path.join(dir, 'src/hidden.ts'), 'fixture');
  assert.ok(!(await scanFiles(dir)).files.includes('src/hidden.ts'));
  await assert.rejects(readText(dir, 'private.txt'), /excluded/);
  await assert.rejects(safePath(dir, 'src/hidden.ts', true), /excluded/);
});
test('range reads are explicit and exact replacements preserve unseen tail', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = 'export const old = 1;\n' + '// padding\n'.repeat(4000) + '// LAST_LINE';
  await fs.writeFile(path.join(dir, 'a.ts'), source);
  const range = await readRange(dir, 'a.ts', 0, 6000);
  assert.equal(range.truncated, true);
  assert.equal(range.nextOffset, 6000);
  assert.equal(range.hash, hash(source));
  assert.ok(replaceExact(source, 'old = 1', 'old = 2').endsWith('// LAST_LINE'));
  assert.throws(() => replaceExact('same same', 'same', 'new'), /exactly once/);
});
test('checkpoint undo preserves intervening editor changes and removes new files', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  const store = new Store(path.join(dir, 'state'));
  await store.load();
  const change: Change = {
    id: 'edit',
    path: 'new.ts',
    before: '',
    after: 'hello',
    status: 'pending',
    workspace: project,
    existed: false,
  };
  store.value.sessions.push({
    id: 's',
    title: 's',
    workspace: project,
    messages: [],
    changes: [change],
    updatedAt: 0,
  });
  await commitChange(store, change);
  assert.equal(change.status, 'applied');
  await fs.writeFile(path.join(project, 'new.ts'), 'user edit');
  await assert.rejects(undoChange(store, 'edit'), /overwrite/);
  assert.equal(await readText(project, 'new.ts'), 'user edit');
  await fs.writeFile(path.join(project, 'new.ts'), 'hello');
  await undoChange(store, 'edit');
  await assert.rejects(fs.stat(path.join(project, 'new.ts')));
});
test('recovery reconciles an interrupted file write without replaying it', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'a.ts'), 'after');
  const store = new Store(path.join(dir, 'state'));
  await store.load();
  store.value.sessions.push({
    id: 's',
    title: 's',
    workspace: project,
    messages: [],
    updatedAt: 0,
    changes: [
      {
        id: 'c',
        path: 'a.ts',
        before: 'before',
        after: 'after',
        workspace: project,
        status: 'applying',
      },
    ],
  });
  store.value.activeRun = {
    id: 'r',
    sessionId: 's',
    workspace: project,
    status: 'waiting',
    label: 'pending',
  };
  await recoverInterrupted(store);
  assert.equal(store.value.activeRun.status, 'interrupted');
  assert.equal(store.value.sessions[0].changes?.[0].status, 'applied');
});
test('map is cached, refreshed after edits, respects exclusions and remains within budget', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.ts'), 'export function greeting(){return "hi"}');
  await fs.writeFile(path.join(root, '.forgeignore'), 'private.ts');
  await fs.writeFile(path.join(root, 'private.ts'), 'export const SECRET = 1');
  const store = new Store(path.join(dir, 'state'));
  await store.load();
  store.value.settings.mapFormat = 'compact';
  const a = await analyzeProject(root, store, store.value.settings);
  assert.ok(a.content.includes('greeting'));
  assert.ok(!a.content.includes('SECRET'));
  assert.ok(a.content.length <= 6500);
  assert.equal(store.cached<{ fingerprint: string }>(`map:${root}`)?.fingerprint, a.fingerprint);
  await fs.writeFile(path.join(root, 'a.ts'), 'export function renamed(){return "hi"}');
  const b = await analyzeProject(root, store, store.value.settings);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.ok(b.content.includes('renamed'));
  assert.ok(renderMap({ ...b, format: 'json' }, '', 1000).length <= 1000);
});
test('provider counts all tool argument bytes across stream frames', async (t) => {
  const { server, endpoint } = await serve((_req, res) => {
    for (let i = 0; i < 11; i++)
      res.write(
        JSON.stringify({
          message: {
            content: '',
            tool_calls: [
              { function: { name: 'write_file', arguments: { content: 'x'.repeat(100000) } } },
            ],
          },
          done: i === 10,
        }) + '\n',
      );
    res.end();
  });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await assert.rejects(
    chat(endpoint, {}, AbortSignal.timeout(5000), () => {}),
    /response limit/,
  );
});
test('connection test uses draft endpoint and verifies generation without saving settings', async (t) => {
  const { server, endpoint } = await serve((req, res) => {
    if (req.url === '/api/tags')
      return res.end(JSON.stringify({ models: [{ name: 'local', size: 1 }] }));
    if (req.url === '/api/show') return res.end('{"capabilities":["tools"]}');
    res.end(JSON.stringify({ message: { content: 'OK' }, done: true }) + '\n');
  });
  t.after(() => server.close());
  const result = await testConnection(endpoint, 'local');
  assert.equal(result.ok, true);
  assert.equal(result.generated, true);
  assert.equal(result.model, 'local');
  assert.equal((await testConnection('https://example.com', '')).ok, false);
});
test('context compaction keeps complete tool groups and latest request', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'old'.repeat(5000) },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read_file', arguments: {} } }],
    },
    { role: 'tool', tool_name: 'read_file', content: 'old source' },
    { role: 'user', content: 'CURRENT TASK' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'list_files', arguments: {} } }],
    },
    { role: 'tool', tool_name: 'list_files', content: 'latest' },
  ];
  const compact = budgetMessages(messages, 4096);
  assert.ok(compact.some((m) => m.content === 'CURRENT TASK'));
  assert.equal(compact.at(-1)?.content, 'latest');
  assert.ok(compact.length < messages.length);
});
test('every tool call receives a result, including calls beyond per-step limit', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  let step = 0,
    count = 0;
  const { server, endpoint } = await serve(async (req, res) => {
    let body = '';
    for await (const part of req) body += part.toString();
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"local","size":1}]}');
    if (req.url === '/api/show') return res.end('{}');
    if (step++ === 0)
      return res.end(
        JSON.stringify({
          message: {
            content: '',
            tool_calls: Array.from({ length: 9 }, () => ({
              function: { name: 'list_files', arguments: {} },
            })),
          },
          done: true,
        }) + '\n',
      );
    count = JSON.parse(body).messages.filter((m: { role: string }) => m.role === 'tool').length;
    res.end(JSON.stringify({ message: { content: 'Done' }, done: true }) + '\n');
  });
  t.after(() => server.close());
  const store = new Store(path.join(dir, 'state'));
  await store.load();
  store.value.workspacePath = project;
  store.value.settings = {
    ...store.value.settings,
    endpoint,
    model: 'local',
    mapFormat: 'compact',
  };
  await new Agent(store, () => {}).run('List files');
  assert.equal(count, 9);
});
test('partial file read cannot authorize full replacement', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'large.ts'), 'x'.repeat(30000));
  let step = 0;
  const events: AgentEvent[] = [];
  const { server, endpoint } = await serve((req, res) => {
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"local","size":1}]}');
    if (req.url === '/api/show') return res.end('{}');
    const calls = [
      { name: 'read_file', arguments: { path: 'large.ts' } },
      { name: 'write_file', arguments: { path: 'large.ts', content: 'lost tail' } },
    ];
    res.end(
      JSON.stringify({
        message:
          step < 2
            ? { content: '', tool_calls: [{ function: calls[step++] }] }
            : { content: 'Done' },
        done: true,
      }) + '\n',
    );
  });
  t.after(() => server.close());
  const store = new Store(path.join(dir, 'state'));
  await store.load();
  store.value.workspacePath = project;
  store.value.settings = {
    ...store.value.settings,
    endpoint,
    model: 'local',
    mapFormat: 'compact',
  };
  await new Agent(store, (e) => events.push(e)).run('Edit');
  assert.ok(!events.some((e) => e.type === 'approval'));
  assert.ok(
    events.some(
      (e) => e.type === 'message' && e.message.content.includes('Full replacement requires'),
    ),
  );
  assert.equal((await readText(project, 'large.ts')).length, 30000);
});
test('grouped dataset excludes drafts and keeps task families out of holdout', () => {
  const examples = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    prompt: 'prompt ' + i,
    response: 'answer',
    createdAt: 0,
    group: 'family' + Math.floor(i / 2),
    reviewed: true,
  }));
  const split = splitDataset([
    ...examples,
    { ...examples[0], id: 'draft', prompt: 'draft', reviewed: false },
  ]);
  assert.equal(split.count, 12);
  const sets = Object.values(split.manifest.examples).map(
    (rows) => new Set(rows.map((r) => r.group)),
  );
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) assert.ok([...sets[i]].every((g) => !sets[j].has(g)));
  assert.throws(
    () => splitDataset([...examples, { ...examples[0], response: 'conflict' }]),
    /Conflicting/,
  );
});
test(
  'executor removes credentials and blocks file escape and network on macOS',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const dir = await fixture();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const project = path.join(dir, 'project'),
      outside = path.join(dir, 'outside.txt');
    await fs.mkdir(project);
    await fs.writeFile(outside, 'fixture');
    const script = path.join(project, 'probe.cjs');
    await fs.writeFile(
      script,
      `const fs=require('fs'),net=require('net');try{fs.readFileSync(${JSON.stringify(outside)});process.exit(3)}catch{console.log('FILE_DENIED')}const s=net.connect(9,'127.0.0.1');s.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))process.exit(6);console.log('NETWORK_DENIED');process.exit(0)});s.on('connect',()=>process.exit(4));setTimeout(()=>process.exit(5),1500);`,
    );
    const result = await execute(
      process.execPath,
      [script],
      project,
      AbortSignal.timeout(10000),
      [project, path.dirname(process.execPath)],
      [project],
    );
    assert.match(result, /FILE_DENIED/);
    assert.match(result, /NETWORK_DENIED/);
    assert.equal(cleanEnvironment().OPENAI_API_KEY, undefined);
    assert.equal(cleanEnvironment().NODE_OPTIONS, undefined);
  },
);

test('TypeScript tools find definitions and references across files', async () => {
  const { languageQuery } = await import('../electron/analysis-engine');
  const files = [
    { path: 'math.ts', source: 'export const add = (a: number, b: number) => a + b;' },
    { path: 'main.ts', source: 'import { add } from "./math";\nexport const result = add(1, 2);' },
  ];
  const definition = languageQuery({
    files,
    query: { kind: 'definition', path: 'main.ts', line: 2, character: 24 },
  }) as { matches: { path: string }[] };
  assert.ok(definition.matches.some((m) => m.path === 'math.ts'));
  const references = languageQuery({
    files,
    query: { kind: 'references', path: 'math.ts', line: 1, character: 14 },
  }) as { matches: { path: string }[] };
  assert.ok(references.matches.some((m) => m.path === 'main.ts'));
});
test('TypeScript diagnostics identify an actual type error', async () => {
  const { languageQuery } = await import('../electron/analysis-engine');
  const result = languageQuery({
    files: [{ path: 'bad.ts', source: 'export const value: number = "wrong";' }],
    query: { kind: 'diagnostics', path: 'bad.ts', line: 1, character: 1 },
  }) as { diagnostics: { code: number }[] };
  assert.ok(result.diagnostics.some((d) => d.code === 2322));
});
test('TypeScript quick info resolves the type at a source position', async () => {
  const { languageQuery } = await import('../electron/analysis-engine');
  const result = languageQuery({
    files: [{ path: 'value.ts', source: 'export const answer: number = 42;' }],
    query: { kind: 'quick_info', path: 'value.ts', line: 1, character: 14 },
  }) as { display: string };
  assert.match(result.display, /answer: number/);
});
test('TypeScript workspace analysis reports compiler posture and available checks', () => {
  const result = analyzeTypeScriptProject(
    [
      {
        path: 'src/App.tsx',
        hash: 'a',
        bytes: 1,
        lines: 1,
        symbols: [],
        imports: [],
      },
      {
        path: 'src/App.test.tsx',
        hash: 'b',
        bytes: 1,
        lines: 1,
        symbols: [],
        imports: [],
      },
    ],
    ['src/App.tsx', 'src/App.test.tsx', 'tsconfig.json'],
    {
      scripts: { test: 'vitest', lint: 'eslint .' },
      dependencies: {},
      devDependencies: { typescript: '^5.9.3', vitest: '^3.0.0', eslint: '^9.0.0' },
    },
    {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          moduleResolution: 'Bundler',
          paths: { '@/*': ['./src/*'] },
        },
        references: [{ path: './tsconfig.node.json' }],
      }),
    },
  );
  assert.equal(result.version, '5.9.3');
  assert.equal(result.compiler.strict, true);
  assert.deepEqual(result.pathAliases, ['@/*']);
  assert.deepEqual(result.projectReferences, ['./tsconfig.node.json']);
  assert.deepEqual(result.testRunners, ['Vitest']);
  assert.equal(
    result.recommendedTools.find((tool) => tool.name === 'Project tests')?.status,
    'detected',
  );
});
test('model chooses map format once and preference is cached', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'a.ts'), 'export const a=1');
  let calls = 0;
  const { server, endpoint } = await serve((req, res) => {
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"local","size":1}]}');
    if (req.url === '/api/show') return res.end('{}');
    calls++;
    res.end(JSON.stringify({ message: { content: '{"format":"json"}' }, done: true }) + '\n');
  });
  t.after(() => server.close());
  const store = new Store(path.join(dir, 'state'));
  await store.load();
  store.value.settings = { ...store.value.settings, endpoint, model: 'local', mapFormat: 'auto' };
  const first = await analyzeProject(project, store, store.value.settings);
  const second = await analyzeProject(project, store, store.value.settings);
  assert.equal(first.format, 'json');
  assert.equal(second.format, 'json');
  assert.equal(calls, 1);
  assert.ok(JSON.parse(first.content).entries.length);
});

test('React Native mental model connects entrypoints, screens, state, navigation and data', () => {
  const entries: ProjectEntry[] = [
    {
      path: 'App.tsx',
      hash: 'a',
      bytes: 1,
      lines: 5,
      symbols: [{ name: 'App', line: 1, kind: 'FunctionDeclaration' }],
      imports: ['./src/navigation/RootNavigator', 'react'],
      roles: ['entrypoint', 'component'],
    },
    {
      path: 'src/navigation/RootNavigator.tsx',
      hash: 'b',
      bytes: 1,
      lines: 8,
      symbols: [{ name: 'RootNavigator', line: 2, kind: 'FunctionDeclaration' }],
      imports: ['../screens/GameScreen', '@react-navigation/native'],
      roles: ['component'],
    },
    {
      path: 'src/screens/GameScreen.tsx',
      hash: 'c',
      bytes: 1,
      lines: 12,
      symbols: [{ name: 'GameScreen', line: 3, kind: 'FunctionDeclaration' }],
      imports: ['../store/gameStore', '../services/gameApi'],
      roles: ['screen', 'component'],
    },
    {
      path: 'src/store/gameStore.ts',
      hash: 'd',
      bytes: 1,
      lines: 7,
      symbols: [{ name: 'useGameStore', line: 1, kind: 'VariableDeclaration' }],
      imports: ['zustand'],
      roles: ['state', 'hook'],
    },
    {
      path: 'src/services/gameApi.ts',
      hash: 'e',
      bytes: 1,
      lines: 7,
      symbols: [{ name: 'loadGame', line: 1, kind: 'FunctionDeclaration' }],
      imports: ['axios'],
      roles: ['api'],
    },
  ];
  const model = buildMentalModel(
    entries,
    ['App.tsx', 'package.json', 'ios/Podfile', 'android/build.gradle'],
    {
      scripts: { ios: 'react-native run-ios', android: 'react-native run-android' },
      dependencies: {
        react: '19.0.0',
        'react-native': '0.81.0',
        zustand: '5.0.0',
        axios: '1.0.0',
        '@react-navigation/native': '7.0.0',
      },
    },
  );
  assert.ok(model.frameworks.some((framework) => framework.name === 'React Native'));
  assert.deepEqual(model.entrypoints, ['App.tsx']);
  assert.ok(model.state.some((item) => item.name === 'Zustand'));
  assert.ok(model.navigation.some((item) => item.name === 'React Navigation'));
  assert.ok(model.data.some((item) => item.name === 'Axios'));
  assert.ok(
    model.relationships.some(
      (edge) => edge.from === 'App.tsx' && edge.to === 'src/navigation/RootNavigator.tsx',
    ),
  );
  const feature = inspectMentalModel(model, entries, 'game', true);
  assert.ok(feature.files.some((item) => item.path === 'src/screens/GameScreen.tsx'));
  assert.ok(feature.relationships.some((edge) => edge.to === 'src/store/gameStore.ts'));
  assert.deepEqual(selectUnderstandingFiles(model, entries, 'game flow'), [
    'App.tsx',
    'src/navigation/RootNavigator.tsx',
    'src/screens/GameScreen.tsx',
    'src/store/gameStore.ts',
    'src/services/gameApi.ts',
  ]);
});

test('printed read-only tool JSON is recovered but mutating calls stay text', () => {
  const recovered = recoverReadOnlyToolCall(
    'Похоже, сначала нужно посмотреть структуру.\n{"name":"list_files","parameters":{}}',
  );
  assert.equal(recovered?.prefix, 'Похоже, сначала нужно посмотреть структуру.');
  assert.equal(recovered?.call.function.name, 'list_files');
  assert.deepEqual(recovered?.call.function.arguments, {});
  assert.equal(
    recoverReadOnlyToolCall('{"name":"write_file","parameters":{"path":"x","content":"y"}}'),
    undefined,
  );
});

test('agent executes a read-only tool printed as JSON instead of ending the turn', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'App.tsx'), 'export function App(){return null}');
  let chatStep = 0;
  let receivedToolResult = false;
  let receivedPreloadedSource = false;
  const { server, endpoint } = await serve(async (req, res) => {
    let body = '';
    for await (const part of req) body += part.toString();
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"local","size":1}]}');
    if (req.url === '/api/show') return res.end('{}');
    const request = JSON.parse(body);
    if (chatStep++ === 0) {
      receivedPreloadedSource = request.messages.some(
        (message: { role: string; content: string }) =>
          message.role === 'system' &&
          message.content.includes('<untrusted_architecture_evidence>') &&
          message.content.includes('export function App(){return null}'),
      );
      return res.end(
        JSON.stringify({
          message: {
            content:
              'Сначала посмотрю архитектуру.\n{"name":"project_mental_model","parameters":{}}',
          },
          done: true,
        }) + '\n',
      );
    }
    receivedToolResult = request.messages.some(
      (message: { role: string; tool_name?: string }) =>
        message.role === 'tool' && message.tool_name === 'project_mental_model',
    );
    res.end(
      JSON.stringify({ message: { content: 'Теперь вижу entrypoint App.tsx.' }, done: true }) +
        '\n',
    );
  });
  t.after(() => server.close());
  const store = new Store(path.join(dir, 'state'));
  await store.load();
  store.value.workspacePath = project;
  store.value.settings = {
    ...store.value.settings,
    endpoint,
    model: 'local',
    mapFormat: 'compact',
  };
  await new Agent(store, () => {}).run('Разберись в проекте.');
  assert.equal(receivedPreloadedSource, true);
  assert.equal(receivedToolResult, true);
  assert.ok(
    store.value.sessions[0].messages.some((message) => message.name === 'project_mental_model'),
  );
  assert.equal(store.value.sessions[0].messages.at(-1)?.content, 'Теперь вижу entrypoint App.tsx.');
});

test('agent repairs a project-understanding draft that only announces a plan', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'App.tsx'), 'export function App(){return null}');
  let chatStep = 0;
  let receivedRepair = false;
  const { server, endpoint } = await serve(async (req, res) => {
    let body = '';
    for await (const part of req) body += part.toString();
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"local","size":1}]}');
    if (req.url === '/api/show') return res.end('{}');
    const request = JSON.parse(body);
    if (chatStep++ === 0)
      return res.end(
        JSON.stringify({ message: { content: 'Сначала я изучу проект.' }, done: true }) + '\n',
      );
    receivedRepair = request.messages.some(
      (message: { role: string; content: string }) =>
        message.role === 'system' && message.content.includes('Rewrite the answer now'),
    );
    res.end(
      JSON.stringify({ message: { content: 'Поток начинается в App.tsx.' }, done: true }) + '\n',
    );
  });
  t.after(() => server.close());
  const store = new Store(path.join(dir, 'state'));
  await store.load();
  store.value.workspacePath = project;
  store.value.settings = {
    ...store.value.settings,
    endpoint,
    model: 'local',
    mapFormat: 'compact',
  };
  await new Agent(store, () => {}).run('Разберись в проекте.');
  assert.equal(receivedRepair, true);
  assert.equal(chatStep, 2);
  assert.equal(store.value.sessions[0].messages.at(-1)?.content, 'Поток начинается в App.tsx.');
});

test('interrupted tool groups cannot leak dangling calls into the next model turn', () => {
  const compact = budgetMessages(
    [
      { role: 'system', content: 'rules' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'read_file', arguments: {} } },
          { function: { name: 'list_files', arguments: {} } },
        ],
      },
      { role: 'tool', tool_name: 'read_file', content: 'source' },
      { role: 'user', content: 'Continue' },
    ],
    4096,
  );
  assert.ok(!compact.some((m) => m.tool_calls?.length));
  assert.ok(!compact.some((m) => m.role === 'tool'));
  assert.equal(compact.at(-1)?.content, 'Continue');
});
