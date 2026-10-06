import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Store } from '../electron/store';
import { mcpProfileSchema, type McpProfile } from '../shared/mcp';
import { connectMcp, callMcp, disconnectMcp, mcpConnections } from '../electron/mcp-client';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-'));
  const store = new Store(path.join(root, 'state'));
  await store.load();
  t.after(async () => {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store };
}
test('MCP profile blocks inline credentials and cleartext remote endpoints', () => {
  const base = { id: randomUUID(), name: 'test', transport: 'http', enabled: true };
  for (const url of [
    'http://example.com/mcp',
    'https://user:pass@example.com/mcp',
    'https://example.com/mcp?token=secret',
  ])
    assert.equal(mcpProfileSchema.safeParse({ ...base, url }).success, false);
  assert.equal(
    mcpProfileSchema.safeParse({ ...base, url: 'http://127.0.0.1:3001/mcp' }).success,
    true,
  );
});
test('real stdio MCP negotiates schemas, enforces grants and redacts credential values', async (t) => {
  const { root, store } = await fixture(t);
  const filename = path.join(root, 'server.mjs');
  await fs.writeFile(
    filename,
    `import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))}; import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))}; import { z } from ${JSON.stringify(import.meta.resolve('zod'))}; const server = new McpServer({ name: 'fixture', version: '1.0.0' }); server.registerTool('sum', { inputSchema: { a: z.number(), b: z.number() } }, async ({a,b}) => ({ content: [{ type: 'text', text: JSON.stringify({ sum: a+b, secret: process.env.FORGE_MCP_TEST_SECRET }) }] })); await server.connect(new StdioServerTransport());`,
  );
  process.env.FORGE_MCP_TEST_SECRET = 'private-test-value\"\nline';
  const profile: McpProfile = {
    id: randomUUID(),
    name: 'Local test',
    transport: 'stdio',
    command: process.execPath,
    args: [filename],
    url: '',
    envNames: ['FORGE_MCP_TEST_SECRET'],
    tokenEnv: '',
    enabled: true,
    allowedTools: ['sum'],
  };
  t.after(async () => {
    delete process.env.FORGE_MCP_TEST_SECRET;
    await disconnectMcp(profile.id);
  });
  const view = await connectMcp(profile, root, store, AbortSignal.timeout(10000));
  assert.equal(view.connected, true);
  assert.equal(view.server?.name, 'fixture');
  assert.equal(view.tools[0].allowed, true);
  const result = await callMcp(
    profile,
    root,
    'sum',
    { a: 2, b: 3 },
    store,
    AbortSignal.timeout(10000),
  );
  assert.match(result, /sum/);
  assert.match(result, /5/);
  assert.equal(result.includes('private-test-value'), false);
  assert.equal(
    result.includes(JSON.stringify(process.env.FORGE_MCP_TEST_SECRET).slice(1, -1)),
    false,
  );
  assert.match(result, /redacted/);
  await assert.rejects(
    callMcp(
      { ...profile, allowedTools: [] },
      root,
      'sum',
      { a: 1, b: 1 },
      store,
      AbortSignal.timeout(1000),
    ),
    /not allowed/,
  );
  await assert.rejects(
    callMcp(profile, root + '-other', 'sum', {}, store, AbortSignal.timeout(1000)),
    /current workspace/,
  );
  await assert.rejects(
    callMcp(profile, root, 'sum', { a: 'bad' }, store, AbortSignal.timeout(10000)),
    /arguments do not match/,
  );
  await assert.rejects(
    callMcp(
      profile,
      root,
      'sum',
      { a: 1, b: 2, password: 'private' },
      store,
      AbortSignal.timeout(10000),
    ),
    /credentials/,
  );
  await disconnectMcp(profile.id, store);
  assert.equal(mcpConnections([profile], root)[0].connected, false);
});
test('real Streamable HTTP MCP connects and calls an allowed tool', async (t) => {
  const { root, store } = await fixture(t);
  const sdkServer = new McpServer({ name: 'http-fixture', version: '1.0.0' });
  sdkServer.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await sdkServer.connect(transport);
  const server = createServer((request, response) => {
    void transport.handleRequest(request, response).catch(() => {
      response.writeHead(500).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const profile: McpProfile = {
    id: randomUUID(),
    name: 'HTTP test',
    transport: 'http',
    command: '',
    args: [],
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
    envNames: [],
    tokenEnv: '',
    enabled: true,
    allowedTools: ['echo'],
  };
  t.after(async () => {
    await disconnectMcp(profile.id);
    await sdkServer.close();
    server.closeAllConnections();
    server.close();
  });
  const view = await connectMcp(profile, root, store, AbortSignal.timeout(10000));
  assert.equal(view.server?.name, 'http-fixture');
  const result = await callMcp(
    profile,
    root,
    'echo',
    { text: 'local HTTP works' },
    store,
    AbortSignal.timeout(10000),
  );
  assert.match(result, /local HTTP works/);
});
