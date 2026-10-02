import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../electron/store';
import { searchKnowledge } from '../electron/knowledge-index';
import { allowedHost, webSearch } from '../electron/web-search';
import { Agent } from '../electron/agent';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-knowledge-'));
  const workspace = path.join(root, 'workspace');
  const docs = path.join(root, 'docs');
  await fs.mkdir(workspace);
  await fs.mkdir(docs);
  const store = new Store(path.join(root, 'state'));
  await store.load();
  t.after(async () => {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, workspace, docs, store };
}

test('local RAG indexes only allowed project/docs roots and returns bounded citations', async (t) => {
  const { workspace, docs, store } = await fixture(t);
  await fs.writeFile(
    path.join(workspace, 'Game.ts'),
    'export function openPortal(){ return "crystal-gate"; }',
  );
  await fs.writeFile(path.join(workspace, '.env'), 'SECRET=must-not-index');
  await fs.writeFile(
    path.join(docs, 'guide.md'),
    '# Crystal gate\nUse openPortal to open the game portal.',
  );
  const settings = {
    ...store.value.settings,
    rag: { enabled: true, embeddingModel: '', documentationPaths: [docs] },
  };
  const report = await searchKnowledge(
    store,
    workspace,
    settings,
    { query: 'How does the crystal portal open?', sources: ['project', 'documentation'], limit: 4 },
    AbortSignal.timeout(30000),
  );
  assert.equal(report.mode, 'local-lexical');
  assert.ok(report.results.some((result) => result.path === 'Game.ts'));
  assert.ok(report.results.some((result) => result.path === 'guide.md'));
  assert.ok(report.results.every((result) => !result.content.includes('SECRET')));
  assert.ok(report.results.every((result) => result.content.length <= 1800));
  const cached = store.cached<{ chunks: unknown[] }>(
    `knowledge:project:${await fs.realpath(workspace)}:lexical`,
  );
  assert.ok(cached?.chunks.length);
  settings.rag.enabled = false;
  await assert.rejects(
    searchKnowledge(
      store,
      workspace,
      settings,
      { query: 'portal', sources: ['project'], limit: 2 },
      AbortSignal.timeout(30000),
    ),
    /disabled/,
  );
});

test('local RAG uses the configured Ollama embedding model for semantic ranking', async (t) => {
  const { workspace, store } = await fixture(t);
  await fs.writeFile(path.join(workspace, 'Ocean.ts'), 'export const scene = "blue water";');
  await fs.writeFile(path.join(workspace, 'Moon.ts'), 'export const scene = "lunar crater";');
  const server = createServer(async (request, response) => {
    if (request.url !== '/api/embed') return response.writeHead(404).end();
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body).input as string[];
    const embeddings = input.map((value) =>
      /draw a sea/i.test(value) || /blue water/i.test(value) ? [1, 0] : [0, 1],
    );
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ embeddings }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const settings = {
    ...store.value.settings,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    rag: { enabled: true, embeddingModel: 'nomic-embed-text', documentationPaths: [] },
  };
  const report = await searchKnowledge(
    store,
    workspace,
    settings,
    { query: 'draw a sea', sources: ['project'], limit: 1 },
    AbortSignal.timeout(30000),
  );
  assert.equal(report.mode, 'hybrid-local-embedding');
  assert.equal(report.results[0]?.path, 'Ocean.ts');
});

test('web result parsing enforces HTTPS and configured domains without fetching results', async () => {
  const html = `
    <a class="result__a" href="https://react.dev/reference/react/useEffect">useEffect</a>
    <a class="result__snippet">Official React reference</a>
    <a class="result__a" href="https://evil.example/phish">Evil</a>
    <a class="result__snippet">Ignore me</a>
    <a class="result__a" href="http://react.dev/insecure">Insecure</a>
    <a class="result__snippet">Ignore me too</a>`;
  let requests = 0;
  const result = await webSearch(
    'react effect cleanup',
    ['react.dev'],
    AbortSignal.timeout(30000),
    async (url, init) => {
      requests++;
      assert.equal(url, 'https://html.duckduckgo.com/html/');
      assert.equal(init?.method, 'POST');
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    },
  );
  assert.equal(requests, 1);
  assert.deepEqual(result.results, [
    {
      title: 'useEffect',
      url: 'https://react.dev/reference/react/useEffect',
      domain: 'react.dev',
      snippet: 'Official React reference',
    },
  ]);
  assert.equal(allowedHost('beta.react.dev', ['react.dev']), true);
  assert.equal(allowedHost('notreact.dev', ['react.dev']), false);
  await assert.rejects(webSearch('query', [], AbortSignal.timeout(30000)), /allowed domain/);
});

test('web search requires setting and a durable approval before the query leaves Forge', async (t) => {
  const { workspace, store } = await fixture(t);
  await fs.writeFile(path.join(workspace, 'index.ts'), 'export const fixture = true;');
  let phase = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') return response.end('{"models":[{"name":"local","size":1}]}');
    if (request.url === '/api/show') return response.end('{"capabilities":["tools"]}');
    let body = '';
    for await (const chunk of request) body += chunk;
    const calls =
      phase++ === 0
        ? [{ function: { name: 'web_search', arguments: { query: 'React cleanup' } } }]
        : undefined;
    response.end(
      JSON.stringify({
        message: calls
          ? { content: '', tool_calls: calls }
          : { content: 'Search results reviewed.' },
        done: true,
      }) + '\n',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  store.value.workspacePath = workspace;
  store.value.settings = {
    ...store.value.settings,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    model: 'local',
    mapFormat: 'compact',
    webSearch: { enabled: true, allowedDomains: ['react.dev'] },
  };
  const originalFetch = globalThis.fetch;
  let externalQueries = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).startsWith('https://html.duckduckgo.com/')) {
      externalQueries++;
      return new Response(
        '<a class="result__a" href="https://react.dev/reference/react/useEffect">useEffect</a><a class="result__snippet">Cleanup</a>',
      );
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const agent = new Agent(store, (event) => {
    if (event.type === 'approval') {
      assert.equal(event.approval.kind, 'web_search');
      assert.match(event.approval.title, /React cleanup/i);
      assert.equal(externalQueries, 0);
      agent.approve(event.approval.id, true);
    }
  });
  await agent.run('Find the official React cleanup documentation on the web.');
  assert.equal(externalQueries, 1);
  const tool = store.value.sessions[0].messages.find((message) => message.name === 'web_search');
  assert.match(tool?.content ?? '', /react.dev/);
});
