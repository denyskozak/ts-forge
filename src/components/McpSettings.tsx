import { useState } from 'react';
import type { McpProfile, McpConnection } from '../../shared/mcp';
import { api } from '../api';
export function McpSettings({
  profiles,
  onChange,
}: {
  profiles: McpProfile[];
  onChange: (profiles: McpProfile[]) => void;
}) {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [working, setWorking] = useState<string>();
  const [error, setError] = useState('');
  const update = (id: string, patch: Partial<McpProfile>) =>
    onChange(profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile)));
  async function connect(profile: McpProfile) {
    setWorking(profile.id);
    setError('');
    try {
      const saved = (await api.state()).settings.mcpServers.find((item) => item.id === profile.id);
      if (JSON.stringify(saved) !== JSON.stringify(profile))
        throw new Error('Save settings before connecting or testing this profile.');
      await api.connectMcp(profile.id);
      setConnections(await api.mcpConnections());
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setWorking(undefined);
    }
  }
  return (
    <section className="settings-card mcp-settings">
      <h3>MCP servers</h3>
      <p>
        Opt-in integrations. Stdio runs local code outside the validation sandbox; remote HTTP sends
        supplied data to the configured server. Credentials are environment variable references,
        never chat values.
      </p>
      <button
        className="button"
        onClick={() =>
          onChange([
            ...profiles,
            {
              id: crypto.randomUUID(),
              name: 'Local MCP',
              transport: 'stdio',
              command: 'node',
              args: [],
              url: '',
              envNames: [],
              tokenEnv: '',
              enabled: false,
              allowedTools: [],
            },
          ])
        }
      >
        Add MCP server
      </button>
      {profiles.map((profile) => {
        const connection = connections.find((item) => item.id === profile.id);
        return (
          <fieldset key={profile.id}>
            <legend>{profile.name}</legend>
            <label>
              Name
              <input
                value={profile.name}
                onChange={(event) => update(profile.id, { name: event.target.value })}
              />
            </label>
            <label>
              Transport
              <select
                value={profile.transport}
                onChange={(event) =>
                  update(profile.id, { transport: event.target.value as 'stdio' | 'http' })
                }
              >
                <option value="stdio">Local stdio process</option>
                <option value="http">Streamable HTTP</option>
              </select>
            </label>
            {profile.transport === 'stdio' ? (
              <>
                <label>
                  Executable
                  <input
                    value={profile.command}
                    onChange={(event) => update(profile.id, { command: event.target.value })}
                  />
                </label>
                <label>
                  Arguments (one per line)
                  <textarea
                    value={profile.args.join('\n')}
                    onChange={(event) =>
                      update(profile.id, { args: event.target.value.split('\n').filter(Boolean) })
                    }
                  />
                </label>
                <label>
                  Environment variable names
                  <input
                    value={profile.envNames.join(', ')}
                    onChange={(event) =>
                      update(profile.id, {
                        envNames: event.target.value
                          .split(',')
                          .map((item) => item.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  MCP endpoint
                  <input
                    value={profile.url}
                    placeholder="http://127.0.0.1:3001/mcp"
                    onChange={(event) => update(profile.id, { url: event.target.value })}
                  />
                </label>
                <label>
                  Bearer token environment variable
                  <input
                    value={profile.tokenEnv}
                    placeholder="MCP_ACCESS_TOKEN"
                    onChange={(event) => update(profile.id, { tokenEnv: event.target.value })}
                  />
                </label>
              </>
            )}
            <label className="task-criterion">
              <input
                type="checkbox"
                checked={profile.enabled}
                onChange={(event) => update(profile.id, { enabled: event.target.checked })}
              />
              Enable this server
            </label>
            <label>
              Allowed tool names (comma separated)
              <input
                value={profile.allowedTools.join(', ')}
                onChange={(event) =>
                  update(profile.id, {
                    allowedTools: event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <div className="mcp-actions">
              <button
                className="button"
                disabled={!profile.enabled || !!working}
                onClick={() => void connect(profile)}
              >
                {working === profile.id ? 'Connecting…' : 'Connect / test'}
              </button>
              <button
                className="button"
                disabled={!!working}
                onClick={() =>
                  void api
                    .disconnectMcp(profile.id)
                    .then(() => api.mcpConnections())
                    .then(setConnections)
                    .catch((error) => setError(error.message))
                }
              >
                Disconnect
              </button>
              <button
                className="button"
                onClick={() => onChange(profiles.filter((item) => item.id !== profile.id))}
              >
                Remove
              </button>
            </div>
            {connection && (
              <div role="status">
                <strong>
                  {connection.connected ? 'Connected' : 'Disconnected'} {connection.server?.name}{' '}
                  {connection.server?.version}
                </strong>
                {connection.tools.map((tool) => (
                  <details key={tool.name}>
                    <summary>
                      {tool.name} ·{' '}
                      {profile.allowedTools.includes(tool.name) ? 'allowed' : 'blocked'}
                    </summary>
                    <p>{tool.description}</p>
                    <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                    <button
                      className="button"
                      onClick={() =>
                        update(profile.id, {
                          allowedTools: profile.allowedTools.includes(tool.name)
                            ? profile.allowedTools.filter((name) => name !== tool.name)
                            : [...profile.allowedTools, tool.name],
                        })
                      }
                    >
                      {profile.allowedTools.includes(tool.name) ? 'Block tool' : 'Allow tool'}
                    </button>
                  </details>
                ))}
              </div>
            )}
          </fieldset>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
