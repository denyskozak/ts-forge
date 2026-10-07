import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { allowedToolNames, selectToolGroups } from '../shared/tool-policy';
import { Store } from '../electron/store';
import { Agent, toolDefinitions } from '../electron/agent';
import { budgetMessages } from '../electron/context';
import { createAnalysisEngine } from '../electron/analysis-engine';
import { r3fSnakeRecipe } from '../electron/r3f-recipes';

test('capability selection reduces schemas and keeps specialist tools discoverable', () => {
  const groups = selectToolGroups('Fix a TypeScript function', [], false);
  const names = allowedToolNames(groups);
  assert.ok(names.has('read_file'));
  assert.ok(names.has('maintenance_audit'));
  for (const name of [
    'ssh_upload_files',
    'mcp_call',
    'browser_click',
    'scaffold_product',
    'web_search',
  ])
    assert.equal(names.has(name), false);
  assert.ok(
    toolDefinitions.filter((tool) => names.has(tool.function.name)).length <
      toolDefinitions.length / 2,
  );
  assert.ok(selectToolGroups('Собери магазин и проверь в браузере').includes('browser'));
  assert.ok(selectToolGroups('Build an R3F scene').includes('scene'));
  assert.ok(allowedToolNames(['core', 'scene']).has('create_r3f_game'));
  assert.ok(selectToolGroups('Inspect current mobile project', ['Expo']).includes('native'));
  assert.ok(allowedToolNames(['core', 'knowledge'], true).has('web_search'));
});

test('R3F snake recipe writes complete gameplay, UI and tests without model-authored source', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-r3f-recipe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'snake', type: 'module', scripts: { dev: 'vite' } }),
  );
  const edits = await r3fSnakeRecipe(root);
  assert.deepEqual(
    edits.map((edit) => edit.path),
    [
      'src/game.ts',
      'src/App.tsx',
      'src/App.css',
      'src/index.css',
      'tests/game.test.ts',
      'package.json',
    ],
  );
  assert.match(edits.find((edit) => edit.path === 'src/App.tsx')!.content, /<Canvas/);
  assert.match(edits.find((edit) => edit.path === 'src/game.ts')!.content, /stepGame/);
  assert.match(
    edits.find((edit) => edit.path === 'tests\/game.test.ts')!.content,
    /self collisions/,
  );
  assert.match(edits.find((edit) => edit.path === 'package.json')!.content, /node --test/);
});
test('context budgeting reserves capacity for advertised schemas', () => {
  const messages = [
    { role: 'system' as const, content: 'Rules' },
    { role: 'user' as const, content: 'x'.repeat(3000) },
  ];
  assert.equal(budgetMessages(messages, 4096).length, 2);
  assert.throws(() => budgetMessages(messages, 4096, 2500), /Context budget/);
});
test('task continues past the configured pass batch until edits and validation finish', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-resume-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'index.ts'), 'export const greeting: string = "before";\n');
  await fs.writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, files: ['index.ts'] }),
  );
  let requestIndex = 0;
  const calls = [
    {
      name: 'plan_task',
      arguments: {
        goal: 'Change greeting',
        criteria: ['Greeting is after'],
        requiredChecks: [{ recipe: 'typescript.check' }],
      },
    },
    { name: 'read_file', arguments: { path: 'index.ts' } },
    {
      name: 'replace_text',
      arguments: { path: 'index.ts', oldText: '"before"', newText: '"after"' },
    },
    { name: 'typecheck', arguments: {} },
  ];
  const received: {
    tools: { function: { name: string } }[];
    messages: { role: string; content: string }[];
  }[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') return response.end('{"models":[{"name":"local","size":1}]}');
    if (request.url === '/api/show') return response.end('{}');
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    const call = calls[requestIndex++];
    response.end(
      JSON.stringify({
        message: call
          ? { content: '', tool_calls: [{ function: call }] }
          : { content: 'Greeting updated and compiler checked.' },
        done: true,
      }) + '\n',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let store = new Store(path.join(directory, 'state'));
  await store.load();
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  store.value.workspacePath = root;
  store.value.settings = {
    ...store.value.settings,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    model: 'local',
    maxSteps: 3,
    mapFormat: 'compact',
  };
  let agent: Agent;
  agent = new Agent(store, (event) => {
    if (event.type === 'approval') queueMicrotask(() => agent.approve(event.approval.id, true));
  });
  await agent.run('Change the greeting to after');
  const session = store.value.sessions[0];
  assert.match(await fs.readFile(path.join(root, 'index.ts'), 'utf8'), /after/);
  assert.equal(session.task?.appliedChanges, 1);
  assert.equal(session.task?.requiredChecks.length, 1);
  assert.equal(session.task?.validations[0].status, 'passed');
  assert.equal(session.checkpoint?.step, 4);
  assert.equal(session.checkpoint?.resumable, false);
  assert.equal(session.messages.filter((message) => message.name === 'replace_text').length, 1);
  assert.ok(
    received.every(
      (request) => !(request.tools ?? []).some((tool) => tool.function.name === 'ssh_upload_files'),
    ),
  );
  assert.match(received[3].messages[0].content, /saved_task_evidence/);
});

test('failed validation is not repeated forever and escalates with three choices', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-validation-repair-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'index.ts'), 'export const value: string = "before";\n');
  await fs.writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, files: ['index.ts'] }),
  );
  let request = 0;
  const calls = [
    {
      name: 'plan_task',
      arguments: {
        goal: 'Change the value',
        criteria: ['Value is changed'],
        requiredChecks: [{ recipe: 'typescript.check' }],
      },
    },
    { name: 'read_file', arguments: { path: 'index.ts' } },
    {
      name: 'replace_text',
      arguments: { path: 'index.ts', oldText: '"before"', newText: '1' },
    },
  ];
  const server = createServer(async (incoming, response) => {
    if (incoming.url === '/api/tags') return response.end('{"models":[{"name":"local","size":1}]}');
    if (incoming.url === '/api/show') return response.end('{}');
    for await (const _chunk of incoming) void _chunk;
    const call = calls[request++];
    response.end(
      JSON.stringify({
        message: call
          ? { content: '', tool_calls: [{ function: call }] }
          : { content: 'The change is complete.' },
        done: true,
      }) + '\n',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const store = new Store(path.join(directory, 'state'));
  await store.load();
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  store.value.workspacePath = root;
  store.value.settings = {
    ...store.value.settings,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    model: 'local',
    mapFormat: 'compact',
  };
  let questionCount = 0;
  let agent: Agent;
  agent = new Agent(store, (event) => {
    if (event.type === 'approval') queueMicrotask(() => agent.approve(event.approval.id, true));
    if (event.type === 'clarification') {
      questionCount++;
      assert.equal(event.clarification.options.length, 3);
      const finish = event.clarification.options.find((option) =>
        option.label.startsWith('Finish'),
      );
      queueMicrotask(() => agent.answerClarification(event.clarification.id, finish!.id));
    }
  });
  await agent.run('Change the exported value.');
  const task = store.value.sessions[0].task!;
  assert.equal(questionCount, 1);
  assert.equal(task.validations.length, 1);
  assert.equal(task.validations[0].status, 'failed');
  assert.equal(task.outcome, 'stopped');
  assert.equal(store.value.sessions[0].checkpoint?.resumable, false);
});

test('semantic rename groups references while preserving shorthand property contracts', () => {
  const engine = createAnalysisEngine();
  const result = engine.query({
    files: [
      { path: 'a.ts', source: 'export const count = 1; export const object = { count };' },
      { path: 'b.ts', source: "import { count } from './a'; export const doubled = count * 2;" },
    ],
    query: { kind: 'rename', path: 'a.ts', line: 1, character: 14, newName: 'quantity' },
    complete: true,
  });
  assert.ok('edits' in result && result.edits);
  if (!('edits' in result) || !result.edits) return;
  assert.equal(result.edits.length, 2);
  assert.match(result.edits[0].content, /count: quantity/);
  assert.match(result.edits[1].content, /quantity \* 2/);
  engine.dispose();
});

test('harness rejects an unloaded tool and advertises it only after a capability switch', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-tool-switch-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } }),
  );
  const requests: string[][] = [];
  const calls = [
    { name: 'package_scripts', arguments: {} },
    {
      name: 'enable_tool_group',
      arguments: { group: 'development', reason: 'Read actual package scripts' },
    },
    { name: 'package_scripts', arguments: {} },
  ];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') return response.end('{"models":[{"name":"local","size":1}]}');
    if (request.url === '/api/show') return response.end('{}');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body.tools.map((tool: { function: { name: string } }) => tool.function.name));
    const call = calls[requests.length - 1];
    response.end(
      JSON.stringify({
        message: call
          ? { content: '', tool_calls: [{ function: call }] }
          : { content: 'Available test script inspected.' },
        done: true,
      }) + '\n',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const store = new Store(path.join(directory, 'state'));
  await store.load();
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  store.value.workspacePath = root;
  store.value.settings = {
    ...store.value.settings,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    model: 'local',
    mapFormat: 'compact',
  };
  await new Agent(store, () => {}).run('Inspect workspace structure');
  assert.equal(requests[0].includes('package_scripts'), false);
  assert.equal(requests[1].includes('package_scripts'), false);
  assert.equal(requests[2].includes('package_scripts'), true);
  assert.ok(
    requests.every((names) => !names.includes('ssh_upload_files') && !names.includes('mcp_call')),
  );
  const receipts = store.value.sessions[0].messages.filter(
    (message) => message.name === 'package_scripts',
  );
  assert.match(receipts[0].content, /Tool is not loaded/);
  assert.match(receipts[1].content, /node --test/);
});
