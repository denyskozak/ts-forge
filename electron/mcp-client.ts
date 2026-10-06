import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { mcpProfileSchema, type McpProfile, type McpConnection } from '../shared/mcp';
import type { Store } from './store';
import { validateMcpArguments } from './mcp-arguments';

type Connection = { client: Client; profile: McpProfile; root: string; view: McpConnection };
const connections = new Map<string, Connection>();
function redact(value: unknown, profile: McpProfile) {
  const secrets = [...profile.envNames, profile.tokenEnv]
    .map((name) => name && process.env[name])
    .filter((secret): secret is string => !!secret)
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'string'
      ? secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), item)
      : item,
  );
}
export function mcpConnections(profiles: McpProfile[], root: string): McpConnection[] {
  return profiles.map((profile) => {
    const connection = connections.get(profile.id);
    return connection?.root === root
      ? {
          ...connection.view,
          tools: connection.view.tools.map((tool) => ({
            ...tool,
            allowed: profile.allowedTools.includes(tool.name),
          })),
        }
      : { id: profile.id, name: profile.name, connected: false, tools: [] };
  });
}
export async function connectMcp(
  input: McpProfile,
  root: string,
  store: Store,
  signal: AbortSignal,
) {
  const profile = mcpProfileSchema.parse(input);
  if (!profile.enabled) throw new Error('Enable this MCP server in Settings first.');
  await disconnectMcp(profile.id, store);
  const client = new Client({ name: 'forge', version: '0.2.0' });
  const secrets: Record<string, string> = {};
  for (const key of profile.envNames) {
    if (!process.env[key])
      throw new Error(`Environment variable ${key} is not available to Forge.`);
    secrets[key] = process.env[key]!;
  }
  if (profile.tokenEnv && !process.env[profile.tokenEnv])
    throw new Error(`Environment variable ${profile.tokenEnv} is not available to Forge.`);
  const transport =
    profile.transport === 'stdio'
      ? new StdioClientTransport({
          command: profile.command,
          args: profile.args,
          cwd: root,
          env: { ...getDefaultEnvironment(), ...secrets },
          stderr: 'pipe',
          maxBufferSize: 1024 * 1024,
        })
      : new StreamableHTTPClientTransport(new URL(profile.url), {
          requestInit: {
            redirect: 'error',
            headers: profile.tokenEnv
              ? { Authorization: `Bearer ${process.env[profile.tokenEnv]}` }
              : {},
          },
        });
  try {
    await client.connect(transport, { signal, timeout: 20_000 });
    const tools: McpConnection['tools'] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools({ cursor }, { signal, timeout: 15_000 });
      for (const tool of result.tools) {
        if (JSON.stringify(tool.inputSchema).length > 20_000) continue;
        tools.push({
          name: tool.name,
          description: tool.description?.slice(0, 2000),
          inputSchema: tool.inputSchema,
          allowed: profile.allowedTools.includes(tool.name),
        });
      }
      cursor = result.nextCursor;
    } while (cursor && tools.length < 100);
    const view: McpConnection = JSON.parse(
      redact(
        {
          id: profile.id,
          name: profile.name,
          connected: true,
          server: client.getServerVersion(),
          capabilities: client.getServerCapabilities(),
          tools: tools.slice(0, 100),
        },
        profile,
      ),
    );
    client.onclose = () => {
      view.connected = false;
    };
    client.onerror = () => {
      view.error = 'MCP connection error. Reconnect to retry.';
    };
    connections.set(profile.id, { client, profile, root, view });
    store.journal('mcp-connected', {
      serverId: profile.id,
      transport: profile.transport,
      tools: view.tools.map((tool) => tool.name),
    });
    return view;
  } catch (error) {
    await client.close().catch(() => {});
    throw new Error(redact({ error: (error as Error).message }, profile));
  }
}
export async function callMcp(
  profile: McpProfile,
  root: string,
  tool: string,
  args: Record<string, unknown>,
  store: Store,
  signal: AbortSignal,
) {
  if (!profile.enabled || !profile.allowedTools.includes(tool))
    throw new Error('This MCP tool is not allowed in Settings.');
  const connection = connections.get(profile.id);
  if (!connection?.view.connected || connection.root !== root)
    throw new Error('Connect this MCP server in the current workspace first.');
  if (JSON.stringify(profile) !== JSON.stringify(connection.profile))
    throw new Error('MCP configuration changed. Reconnect before calling tools.');
  if (!connection.view.tools.some((item) => item.name === tool))
    throw new Error('Server does not advertise this tool.');
  validateMcpArguments(args);
  const definition = connection.view.tools.find((item) => item.name === tool)!;
  const validation = new AjvJsonSchemaValidator().getValidator(definition.inputSchema)(args);
  if (!validation.valid)
    throw new Error(`MCP arguments do not match the discovered schema: ${validation.errorMessage}`);
  const startedAt = Date.now();
  try {
    const result = await connection.client.callTool({ name: tool, arguments: args }, undefined, {
      signal,
      timeout: 30_000,
    });
    const text = redact(result, profile);
    store.journal('mcp-called', {
      serverId: profile.id,
      tool,
      isError: !!result.isError,
      durationMs: Date.now() - startedAt,
    });
    return text.length <= 48_000
      ? text
      : JSON.stringify({
          truncated: true,
          isError: !!result.isError,
          excerpt: text.slice(0, 40_000),
        });
  } catch (error) {
    store.journal('mcp-failed', { serverId: profile.id, tool, durationMs: Date.now() - startedAt });
    throw new Error(redact({ error: (error as Error).message }, profile));
  }
}
export async function disconnectMcp(id: string, store?: Store) {
  const connection = connections.get(id);
  if (!connection) return;
  connections.delete(id);
  await connection.client.close();
  store?.journal('mcp-disconnected', { serverId: id });
}
export async function closeMcpConnections() {
  await Promise.all([...connections.keys()].map((id) => disconnectMcp(id).catch(() => {})));
}
