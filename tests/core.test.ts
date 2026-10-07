import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { safePath, readText, applyChange, listFiles } from '../electron/workspace';
import { localEndpoint, models, chat } from '../electron/provider';
import { splitDataset } from '../electron/training';
import { Store } from '../electron/store';
import { Agent, requestsProjectChange, scaffoldTemplateForPrompt } from '../electron/agent';
import type { AgentEvent, Approval, Example } from '../shared/types';
async function fixture() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
}
test('endpoint permits loopback only and rejects credentials, redirects and paths', () => {
  assert.equal(localEndpoint('http://localhost:11434'), 'http://127.0.0.1:11434');
  assert.equal(localEndpoint('http://[::1]:11434'), 'http://[::1]:11434');
  for (const url of [
    'https://ollama.com',
    'http://192.168.0.1:11434',
    'http://localhost.evil.test',
    'file:///etc/passwd',
    'http://user:pass@localhost',
    'http://localhost/api',
    'http://localhost?x=y',
  ])
    assert.throws(() => localEndpoint(url));
});
test('workspace protects traversal, secrets, symlink parents and ignored directories', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'index.ts'), 'export const ok = true;');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, '.env'), 'secret');
  await fs.symlink(os.tmpdir(), path.join(root, 'linked'));
  for (const file of [
    '../elsewhere.ts',
    '/etc/passwd',
    '.env',
    '.env.local',
    'node_modules/foo.ts',
    'linked/new.ts',
  ])
    await assert.rejects(safePath(root, file, true));
  assert.deepEqual(await listFiles(root), ['index.ts']);
  assert.equal(await readText(root, 'index.ts'), 'export const ok = true;');
});
test('reviewed writes reject stale content and create nested new files', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.ts'), 'original');
  await assert.rejects(applyChange(root, 'a.ts', 'stale', 'changed'), /changed since review/);
  await applyChange(root, 'a.ts', 'original', 'changed');
  assert.equal(await readText(root, 'a.ts'), 'changed');
  await applyChange(root, 'src/new.ts', '', 'new');
  assert.equal(await readText(root, 'src/new.ts'), 'new');
});
test('binary and oversized files cannot enter model context', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, 'large'), 'x'.repeat(200001));
  await assert.rejects(readText(root, 'binary'), /Binary/);
  await assert.rejects(readText(root, 'large'), /200 KB/);
});
test('dataset deduplicates prompts and keeps validation separate', () => {
  const examples: Example[] = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    prompt: `Task ${i}`,
    response: `Answer ${i}`,
    createdAt: i,
  }));
  const split = splitDataset([...examples, examples[0]]);
  assert.equal(split.count, 10);
  const train = split.train
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s).messages[0].content);
  const valid = split.valid
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s).messages[0].content);
  assert.equal(train.length, 6);
  assert.equal(valid.length, 2);
  assert.ok(train.every((p) => !valid.includes(p)));
  assert.throws(() => splitDataset(examples.slice(0, 4)), /at least 5/);
});
test('serialized persistence survives overlapping saves', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.load();
  store.value.settings.model = 'first';
  const first = store.save();
  store.value.settings.model = 'second';
  const second = store.save();
  await Promise.all([first, second]);
  const reloaded = new Store(root);
  await reloaded.load();
  assert.equal(reloaded.value.settings.model, 'second');
});
async function mockServer(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
test('provider filters cloud models and blocks redirects', async (t) => {
  const { server, endpoint } = await mockServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        models: [
          { name: 'local', size: 1 },
          { name: 'remote-cloud', size: 1 },
          { name: 'remote', remote_host: 'https://ollama.com' },
        ],
      }),
    );
  });
  t.after(() => server.close());
  assert.deepEqual(
    (await models(endpoint)).map((m) => m.name),
    ['local'],
  );
  const redirect = await mockServer((_req, res) => {
    res.writeHead(302, { Location: 'http://example.com' });
    res.end();
  });
  t.after(() => redirect.server.close());
  await assert.rejects(models(redirect.endpoint));
});
test('provider handles fragmented UTF-8 NDJSON and tool calls', async (t) => {
  const { server, endpoint } = await mockServer((_req, res) => {
    const output = Buffer.from(
      JSON.stringify({ message: { content: 'Привет' } }) +
        '\n' +
        JSON.stringify({
          message: { tool_calls: [{ function: { name: 'list_files', arguments: {} } }] },
          done: true,
        }) +
        '\n',
    );
    res.write(output.subarray(0, 27));
    res.write(output.subarray(27, 30));
    res.end(output.subarray(30));
  });
  t.after(() => server.close());
  let streamed = '';
  const answer = await chat(endpoint, {}, new AbortController().signal, (s) => (streamed += s));
  assert.equal(streamed, 'Привет');
  assert.equal(answer.tool_calls?.[0].function.name, 'list_files');
});
test('provider detects interrupted streams', async (t) => {
  const { server, endpoint } = await mockServer((_req, res) =>
    res.end(JSON.stringify({ message: { content: 'partial' } }) + '\n'),
  );
  t.after(() => server.close());
  await assert.rejects(
    chat(endpoint, {}, new AbortController().signal, () => {}),
    /ended early/,
  );
});
for (const decision of ['approve', 'deny', 'stop'] as const)
  test(`agent read → review → ${decision} → persisted session`, async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'project'));
    const project = path.join(root, 'project');
    await fs.writeFile(path.join(project, 'index.ts'), 'const old = 1;');
    await fs.writeFile(
      path.join(project, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { noEmit: true }, files: ['index.ts'] }),
    );
    let step = 0;
    const { server, endpoint } = await mockServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags')
        return res.end(JSON.stringify({ models: [{ name: 'test:local', size: 1 }] }));
      if (req.url === '/api/show') return res.end('{}');
      const calls = [
        {
          name: 'plan_task',
          arguments: {
            goal: 'Improve the type',
            criteria: ['The better variable is persisted'],
            requiredChecks: [{ recipe: 'typescript.check' }],
          },
        },
        { name: 'read_file', arguments: { path: 'index.ts' } },
        { name: 'write_file', arguments: { path: 'index.ts', content: 'const better = 2;' } },
      ];
      const message =
        step < calls.length
          ? { content: '', tool_calls: [{ function: calls[step++] }] }
          : { content: 'Finished.' };
      res.end(JSON.stringify({ message, done: true }) + '\n');
    });
    t.after(() => server.close());
    const store = new Store(path.join(root, 'data'));
    await store.load();
    store.value.workspacePath = project;
    store.value.settings = {
      ...store.value.settings,
      endpoint,
      model: 'test:local',
      mapFormat: 'compact',
    };
    const events: AgentEvent[] = [];
    const agent = new Agent(store, (event) => {
      events.push(event);
      if (event.type === 'approval')
        queueMicrotask(() => {
          if (decision === 'stop') agent.stop();
          else agent.approve(event.approval.id, decision === 'approve');
        });
    });
    await agent.run('Improve the type.');
    assert.equal(agent.busy, false);
    assert.equal(
      await fs.readFile(path.join(project, 'index.ts'), 'utf8'),
      decision === 'approve' ? 'const better = 2;' : 'const old = 1;',
    );
    assert.ok(events.some((e) => e.type === 'approval'));
    assert.equal(events.at(-1)?.type, 'done');
    const reloaded = new Store(path.join(root, 'data'));
    await reloaded.load();
    assert.equal(reloaded.value.sessions.length, 1);
  });

for (const custom of [false, true])
  test(`agent pauses for a critical question and accepts ${custom ? 'free text' : 'an option'}`, async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'index.ts'), 'export const mode = "safe";\n');
    let step = 0;
    const requests: Record<string, unknown>[] = [];
    const { server, endpoint } = await mockServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/api/tags')
        return res.end(JSON.stringify({ models: [{ name: 'test:local', size: 1 }] }));
      if (req.url === '/api/show') return res.end('{}');
      requests.push(body);
      const message =
        step++ === 0
          ? {
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'write_file',
                    arguments: { path: 'index.ts', content: 'export const mode = "changed";\n' },
                  },
                },
                {
                  function: {
                    name: 'ask_user_question',
                    arguments: {
                      question: 'Which compatibility target should this change use?',
                      reason: 'The target changes the public API and generated output.',
                      options: custom
                        ? ['Modern only', 'Legacy compatible']
                        : [
                            { label: 'Modern only', description: 'Use the current runtime API.' },
                            { label: 'Legacy compatible', description: 'Preserve the older API.' },
                          ],
                    },
                  },
                },
              ],
            }
          : { content: 'Kept the legacy-compatible design.' };
      res.end(JSON.stringify({ message, done: true }) + '\n');
    });
    t.after(() => server.close());
    const store = new Store(path.join(root, 'data'));
    await store.load();
    store.value.workspacePath = project;
    store.value.settings = {
      ...store.value.settings,
      endpoint,
      model: 'test:local',
      mapFormat: 'compact',
    };
    let observedWaitingState = false;
    const events: AgentEvent[] = [];
    const agent = new Agent(store, (event) => {
      events.push(event);
      if (event.type === 'clarification') {
        assert.equal(event.clarification.options.length, 3);
        observedWaitingState =
          store.value.activeRun?.status === 'waiting' &&
          store.value.activeRun.clarification?.id === event.clarification.id;
        const answer = event.clarification.options.find(
          (option) => option.label === 'Legacy compatible',
        );
        assert.throws(() => agent.answerClarification(event.clarification.id, 'custom', '  '));
        queueMicrotask(() =>
          agent.answerClarification(
            event.clarification.id,
            custom ? 'custom' : answer!.id,
            custom ? 'Support both APIs' : undefined,
          ),
        );
      }
    });
    await agent.run('Update the compatibility layer.');
    assert.equal(observedWaitingState, true);
    assert.ok(events.some((event) => event.type === 'clarification'));
    assert.equal(
      await fs.readFile(path.join(project, 'index.ts'), 'utf8'),
      'export const mode = "safe";\n',
    );
    const toolMessages = store.value.sessions[0].messages.filter(
      (message) => message.role === 'tool',
    );
    assert.match(toolMessages.find((message) => message.name === 'write_file')!.content, /Skipped/);
    assert.deepEqual(
      JSON.parse(toolMessages.find((message) => message.name === 'ask_user_question')!.content),
      custom
        ? { answer: 'Support both APIs' }
        : {
            answer: 'Legacy compatible',
            description: 'Preserve the older API.',
          },
    );
    const nextMessages = (requests[1].messages as { role: string; content: string }[]).filter(
      (message) => message.role === 'tool',
    );
    assert.ok(
      nextMessages.some((message) =>
        message.content.includes(custom ? 'Support both APIs' : 'Legacy compatible'),
      ),
    );
  });

test(
  'MLX launcher writes real datasets, uses offline flags and reports process exit',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' },
  async (t) => {
    const { Trainer } = await import('../electron/training');
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const model = path.join(root, 'model');
    await fs.mkdir(model);
    await fs.writeFile(path.join(model, 'config.json'), '{}');
    const executable = path.join(root, 'fake-mlx');
    await fs.writeFile(
      executable,
      '#!/bin/sh\nmkdir -p adapters\nprintf test > adapters/adapters.safetensors\nprintf "offline=%s telemetry=%s\\n" "$HF_HUB_OFFLINE" "$HF_HUB_DISABLE_TELEMETRY"\nprintf "%s\\n" "$@"\n',
      { mode: 0o700 },
    );
    const events: AgentEvent[] = [];
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const trainer = new Trainer(root, (event) => {
      events.push(event);
      if (event.type === 'training' && !event.running) finish();
    });
    const examples = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      prompt: `p${i}`,
      response: `r${i}`,
      createdAt: i,
    }));
    const job = await trainer.run(
      { executable, modelPath: model, iterations: 3, learningRate: 0.00001, batchSize: 1 },
      examples,
    );
    await done;
    const output = events
      .filter((e) => e.type === 'training')
      .map((e) => e.text)
      .join('');
    assert.match(output, /offline=1 telemetry=1/);
    assert.match(output, /--mask-prompt/);
    assert.match(output, /Adapter saved/);
    assert.equal(
      (await fs.readFile(path.join(job, 'data/train.jsonl'), 'utf8')).trim().split('\n').length,
      3,
    );
    assert.ok(
      JSON.parse(await fs.readFile(path.join(job, 'run.json'), 'utf8')).args.includes(
        '--adapter-path',
      ),
    );
  },
);

test('implementation-only prose cannot silently complete a task without files', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  let calls = 0;
  const { server, endpoint } = await mockServer(async (req, res) => {
    for await (const _ of req) {
      /* drain body */
    }
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"test:local","size":1}]}');
    if (req.url === '/api/show') return res.end('{}');
    calls++;
    res.end(
      JSON.stringify({
        message: { content: 'Here is your app. Everything is ready.' },
        done: true,
      }) + '\n',
    );
  });
  t.after(() => server.close());
  const store = new Store(path.join(root, 'data'));
  await store.load();
  t.after(() => store.close());
  store.value.workspacePath = project;
  store.value.settings = {
    ...store.value.settings,
    endpoint,
    model: 'test:local',
    mapFormat: 'compact',
  };
  let clarificationSeen = false;
  let agent: Agent;
  agent = new Agent(store, (event) => {
    if (event.type !== 'clarification') return;
    clarificationSeen = true;
    assert.equal(event.clarification.options.length, 3);
    const finish = event.clarification.options.find((option) => option.label.startsWith('Finish'));
    queueMicrotask(() => agent.answerClarification(event.clarification.id, finish!.id));
  });
  await agent.run('Create a calculator application.');
  assert.equal(calls, 7);
  assert.equal(clarificationSeen, true);
  assert.equal(store.value.sessions[0].task?.outcome, 'stopped');
  assert.equal(store.value.sessions[0].checkpoint?.resumable, false);
  assert.match(store.value.sessions[0].messages.at(-1)!.content, /no changes were applied/i);
  assert.deepEqual(await fs.readdir(project), []);
});

test('Russian build slang routes an empty R3F feature through the complete game recipe', async (t) => {
  const prompt =
    'давай забилдим игру на r3f в 2д змейку на клавиатуре, сделай поиск по правилам игры и имплементируй их';
  assert.equal(requestsProjectChange(prompt), true);
  assert.equal(
    requestsProjectChange(
      'а можешь сделать так чтоб когда змейка сталкивается с концом карты она переносилась на противоположный конец',
    ),
    true,
  );
  assert.equal(scaffoldTemplateForPrompt(prompt), 'r3f');
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'snake-project');
  await fs.mkdir(project);
  let calls = 0;
  const { server, endpoint } = await mockServer(async (req, res) => {
    for await (const _ of req) {
      /* drain body */
    }
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"test:local","size":1}]}');
    if (req.url === '/api/show') return res.end('{}');
    calls++;
    const message =
      calls === 1
        ? {
            content: '',
            tool_calls: [
              { function: { name: 'create_r3f_game', arguments: { recipe: 'snake' } } },
            ],
          }
        : { content: 'The requested project changes were declined.' };
    res.end(`${JSON.stringify({ message, done: true })}\n`);
  });
  t.after(() => server.close());
  const store = new Store(path.join(root, 'data'));
  await store.load();
  t.after(() => store.close());
  store.value.workspacePath = project;
  store.value.settings = {
    ...store.value.settings,
    endpoint,
    model: 'test:local',
    mapFormat: 'compact',
  };
  const approvals: Approval[] = [];
  const agent = new Agent(store, (event) => {
    if (event.type !== 'approval') return;
    approvals.push(event.approval);
    queueMicrotask(() => agent.approve(event.approval.id, false));
  });
  await agent.run(prompt);
  assert.equal(calls, 2);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, 'changeset');
  assert.match(approvals[0].title, /complete R3F snake game/i);
  assert.equal(store.value.sessions[0].task?.outcome, 'failed');
  assert.equal(store.value.sessions[0].checkpoint?.resumable, true);
  assert.match(store.value.sessions[0].messages.at(-1)!.content, /no changes were applied/i);
  assert.deepEqual(await fs.readdir(project), []);
});
