import { useEffect, useState } from 'react';
import {
  Check,
  Cpu,
  RefreshCw,
  ShieldCheck,
  HardDrive,
  Terminal,
  Map,
  CircleCheck,
  CircleAlert,
  MessageSquare,
  Plus,
} from 'lucide-react';
import { api } from './api';
import { McpSettings } from './components/McpSettings';
import {
  SPEECH_LANGUAGES,
  type Settings,
  type ConnectionTest,
  type SshProfile,
  type Session,
} from '../shared/types';
export default function SettingsPage({
  settings,
  dataPath,
  platform,
  sessions,
  activeSessionId,
  busy,
  onNewSession,
  onOpenSession,
  onSave,
}: {
  settings: Settings;
  dataPath: string;
  platform: string;
  sessions: Session[];
  activeSessionId?: string;
  busy: boolean;
  onNewSession: () => void;
  onOpenSession: (session: Session) => void;
  onSave: (settings: Settings) => void;
}) {
  const [draft, setDraft] = useState(settings),
    [testing, setTesting] = useState(false),
    [result, setResult] = useState<ConnectionTest>(),
    [sshTesting, setSshTesting] = useState<string>(),
    [sshResult, setSshResult] = useState<{ id: string; ok: boolean; message: string }>();
  useEffect(() => {
    setDraft(settings);
    setResult(undefined);
  }, [settings]);
  const update = (value: Partial<Settings>) => {
    setDraft((old) => ({ ...old, ...value }));
    setResult(undefined);
  };
  async function test() {
    setTesting(true);
    setResult(undefined);
    try {
      setResult(await api.testConnection(draft.endpoint, draft.model));
    } catch (error) {
      setResult({
        ok: false,
        endpoint: draft.endpoint,
        models: [],
        latencyMs: 0,
        message: (error as Error).message,
      });
    } finally {
      setTesting(false);
    }
  }
  async function addDocumentationDirectory() {
    try {
      const selected = await api.pickPath('directory');
      if (!selected || draft.rag.documentationPaths.includes(selected)) return;
      update({
        rag: { ...draft.rag, documentationPaths: [...draft.rag.documentationPaths, selected] },
      });
    } catch (error) {
      setResult({
        ok: false,
        endpoint: draft.endpoint,
        models: [],
        latencyMs: 0,
        message: (error as Error).message,
      });
    }
  }
  const updateSsh = (id: string, value: Partial<SshProfile>) =>
    update({
      sshProfiles: draft.sshProfiles.map((profile) =>
        profile.id === id ? { ...profile, ...value } : profile,
      ),
    });
  async function chooseSshKey(id: string) {
    const selected = await api.pickPath('file');
    if (selected) updateSsh(id, { keyPath: selected });
  }
  async function testSshProfile(profile: SshProfile) {
    setSshTesting(profile.id);
    setSshResult(undefined);
    try {
      const response = await api.testSshProfile(profile);
      setSshResult({
        id: profile.id,
        ok: response.ok,
        message: response.ok
          ? `Connected in ${response.latencyMs} ms`
          : response.output || 'Connection failed.',
      });
    } catch (error) {
      setSshResult({ id: profile.id, ok: false, message: (error as Error).message });
    } finally {
      setSshTesting(undefined);
    }
  }
  return (
    <div className="page-inner">
      <div className="page-header">
        <h1>Settings</h1>
        <p>Local models, project context and private workspace data.</p>
      </div>
      <div className="settings-card session-history-card">
        <div className="settings-card-heading">
          <div>
            <h3>Session history</h3>
            <p className="muted-text">Chats for the current workspace stay on this machine.</p>
          </div>
          <button className="button" onClick={onNewSession} disabled={busy}>
            <Plus size={14} />
            New chat
          </button>
        </div>
        <div className="settings-session-list">
          {sessions.length ? (
            sessions.map((session) => (
              <button
                key={session.id}
                className={session.id === activeSessionId ? 'active' : ''}
                disabled={busy}
                onClick={() => onOpenSession(session)}
              >
                <MessageSquare size={15} />
                <span>
                  <strong>{session.title}</strong>
                  <small>{new Date(session.updatedAt).toLocaleString()}</small>
                </span>
              </button>
            ))
          ) : (
            <div className="settings-session-empty">No sessions in this workspace yet.</div>
          )}
        </div>
      </div>
      <div className="settings-card">
        <h3>Local runtime</h3>
        <label>
          Ollama endpoint
          <input
            disabled={testing}
            value={draft.endpoint}
            onChange={(e) => update({ endpoint: e.target.value })}
          />
          <small>
            Local HTTP address, e.g. http://127.0.0.1:11434. Forge connects to Ollama; this is not a
            path to a GGUF file.
          </small>
        </label>
        <label>
          Local model
          <input
            aria-label="Local model"
            list="connection-models"
            disabled={testing}
            placeholder="Select a model or enter its Ollama name"
            value={draft.model}
            onChange={(e) => update({ model: e.target.value })}
          />
          <datalist id="connection-models">
            {result?.models.map((model) => (
              <option key={model.name} value={model.name} />
            ))}
          </datalist>
          <small>
            Leave empty to discover models. Choose one and test again to verify generation.
          </small>
        </label>
        <div className="connection-test-actions">
          <button className="button" onClick={test} disabled={testing}>
            <RefreshCw size={14} className={testing ? 'spin' : ''} />
            {testing ? 'Testing local model…' : 'Test connection'}
          </button>
          <span>Tests these values without saving them.</span>
        </div>
        {result && (
          <div className={`connection-result ${result.ok ? 'success' : 'failure'}`} role="status">
            {result.ok ? <CircleCheck size={18} /> : <CircleAlert size={18} />}
            <div>
              <strong>{result.ok ? 'Connection verified' : 'Connection failed'}</strong>
              <p>{result.message}</p>
              <small>
                {result.endpoint} · {result.latencyMs} ms
                {result.generated ? ' · generation verified' : ''}
              </small>
              {result.models.length > 0 && (
                <div className="connection-models">
                  {result.models.map((model) => (
                    <button
                      key={model.name}
                      onClick={() => {
                        setDraft((old) => ({ ...old, model: model.name }));
                        setResult(undefined);
                      }}
                    >
                      {model.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="form-row" style={{ marginTop: 24 }}>
          <label>
            Temperature
            <input
              type="number"
              min="0"
              max="1"
              step="0.1"
              value={draft.temperature}
              onChange={(e) => update({ temperature: Number(e.target.value) })}
            />
          </label>
          <label>
            Maximum agent steps
            <input
              type="number"
              min="1"
              max="30"
              value={draft.maxSteps}
              onChange={(e) => update({ maxSteps: Number(e.target.value) })}
            />
          </label>
        </div>
        <label style={{ marginTop: 24 }}>
          On-device speech language
          <select
            aria-label="Speech recognition language"
            value={draft.speechLanguage === 'en-US' ? 'auto' : draft.speechLanguage}
            onChange={(e) =>
              update({ speechLanguage: e.target.value as Settings['speechLanguage'] })
            }
          >
            {SPEECH_LANGUAGES.map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
                {language.value === 'auto' ? ' · recommended' : ''}
              </option>
            ))}
          </select>
          <small>
            Automatic mode uses the local English (US) dictation pack because regional browser
            locales may not be downloadable. Forge never sends voice to remote recognition.
          </small>
        </label>
      </div>
      <div className="settings-card">
        <h3>
          <Map size={17} /> Project analysis & context
        </h3>
        <p className="muted-text">
          Forge refreshes a local map before each task. It indexes files, symbols, imports and
          framework versions, then sends only entries relevant to your request.
        </p>
        <div className="form-row" style={{ marginTop: 20 }}>
          <label>
            Map format
            <select
              aria-label="Map format"
              value={draft.mapFormat}
              onChange={(e) => update({ mapFormat: e.target.value as Settings['mapFormat'] })}
            >
              <option value="auto">Auto — let the local model choose</option>
              <option value="compact">Compact text</option>
              <option value="json">JSON</option>
              <option value="markdown">Markdown table</option>
            </select>
            <small>
              The model’s preference is cached. A compact fallback is used if it cannot choose.
            </small>
          </label>
          <label>
            Context window
            <input
              type="number"
              min="4096"
              max="65536"
              step="1024"
              value={draft.contextTokens}
              onChange={(e) => update({ contextTokens: Number(e.target.value) })}
            />
            <small>
              Token budget; larger windows need more memory. Source text is never silently cut to
              fit.
            </small>
          </label>
        </div>
      </div>
      <div className="settings-card">
        <h3>
          <HardDrive size={17} /> Local RAG & documentation
        </h3>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.rag.enabled}
            onChange={(e) => update({ rag: { ...draft.rag, enabled: e.target.checked } })}
          />
          Search the project and selected local documentation before using broad context
        </label>
        <label style={{ marginTop: 20 }}>
          Local embedding model (optional)
          <input
            aria-label="Local embedding model"
            value={draft.rag.embeddingModel}
            placeholder="e.g. nomic-embed-text"
            onChange={(e) => update({ rag: { ...draft.rag, embeddingModel: e.target.value } })}
          />
          <small>
            Runs through your loopback Ollama endpoint. Leave empty for private lexical retrieval
            with no embedding request.
          </small>
        </label>
        <div className="settings-paths">
          <strong>Documentation directories</strong>
          <span>Only folders you add here are indexed. Files stay local.</span>
          {draft.rag.documentationPaths.map((directory) => (
            <div key={directory} className="settings-path">
              <code>{directory}</code>
              <button
                onClick={() =>
                  update({
                    rag: {
                      ...draft.rag,
                      documentationPaths: draft.rag.documentationPaths.filter(
                        (item) => item !== directory,
                      ),
                    },
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button className="button" onClick={() => void addDocumentationDirectory()}>
            Add documentation folder
          </button>
        </div>
      </div>
      <div className="settings-card">
        <h3>
          <ShieldCheck size={17} /> Optional web search
        </h3>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.webSearch.enabled}
            onChange={(e) =>
              update({ webSearch: { ...draft.webSearch, enabled: e.target.checked } })
            }
          />
          Allow approved web searches
        </label>
        <label style={{ marginTop: 20 }}>
          Allowed documentation domains
          <textarea
            aria-label="Allowed web search domains"
            rows={3}
            value={draft.webSearch.allowedDomains.join('\n')}
            onChange={(e) =>
              update({
                webSearch: {
                  ...draft.webSearch,
                  allowedDomains: e.target.value
                    .split(/[\n,]/)
                    .map((domain) => domain.trim().toLowerCase())
                    .filter(Boolean),
                },
              })
            }
          />
          <small>
            Queries go to DuckDuckGo only after you approve the exact query. Forge returns HTTPS
            results limited to these domains and never fetches result pages.
          </small>
        </label>
      </div>
      <div className="settings-card">
        <h3>
          <Terminal size={17} /> SSH servers
        </h3>
        <p className="muted-text">
          Profiles store connection metadata and a key path. Private keys and passphrases are never
          copied into Forge. Load encrypted keys into your system SSH agent before testing them.
        </p>
        <div className="ssh-profiles">
          {draft.sshProfiles.map((profile) => (
            <div className="ssh-profile" key={profile.id}>
              <div className="form-row">
                <label>
                  Profile name
                  <input
                    value={profile.name}
                    onChange={(event) => updateSsh(profile.id, { name: event.target.value })}
                  />
                </label>
                <label>
                  Host
                  <input
                    value={profile.host}
                    placeholder="server.example.com"
                    onChange={(event) => updateSsh(profile.id, { host: event.target.value })}
                  />
                </label>
              </div>
              <div className="form-row ssh-connection-row">
                <label>
                  User
                  <input
                    value={profile.user}
                    onChange={(event) => updateSsh(profile.id, { user: event.target.value })}
                  />
                </label>
                <label>
                  Port
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={profile.port}
                    onChange={(event) =>
                      updateSsh(profile.id, { port: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Credentials
                  <select
                    value={profile.auth}
                    onChange={(event) =>
                      updateSsh(profile.id, { auth: event.target.value as SshProfile['auth'] })
                    }
                  >
                    <option value="system">System SSH config / agent</option>
                    <option value="key">Private key file</option>
                  </select>
                </label>
              </div>
              {profile.auth === 'key' && (
                <div className="settings-path">
                  <code>{profile.keyPath || 'No key selected'}</code>
                  <button onClick={() => void chooseSshKey(profile.id)}>Choose key</button>
                </div>
              )}
              <div className="ssh-profile-actions">
                <button
                  className="button"
                  disabled={sshTesting === profile.id}
                  onClick={() => void testSshProfile(profile)}
                >
                  <RefreshCw size={14} className={sshTesting === profile.id ? 'spin' : ''} />
                  Test SSH
                </button>
                <button
                  className="button"
                  onClick={() =>
                    update({
                      sshProfiles: draft.sshProfiles.filter((item) => item.id !== profile.id),
                    })
                  }
                >
                  Remove
                </button>
              </div>
              {sshResult?.id === profile.id && (
                <div
                  className={`connection-result ${sshResult.ok ? 'success' : 'failure'}`}
                  role="status"
                >
                  {sshResult.ok ? <CircleCheck size={18} /> : <CircleAlert size={18} />}
                  <div>
                    <strong>{sshResult.ok ? 'SSH verified' : 'SSH failed'}</strong>
                    <p>{sshResult.message}</p>
                  </div>
                </div>
              )}
            </div>
          ))}
          <button
            className="button"
            onClick={() =>
              update({
                sshProfiles: [
                  ...draft.sshProfiles,
                  {
                    id: crypto.randomUUID(),
                    name: 'Server',
                    host: '',
                    port: 22,
                    user: '',
                    auth: 'system',
                    keyPath: '',
                  },
                ],
              })
            }
          >
            Add SSH server
          </button>
        </div>
      </div>
      <button className="primary" onClick={() => onSave(draft)} disabled={testing}>
        <Check size={15} />
        Save settings
      </button>
      <div className="settings-card" style={{ marginTop: 24 }}>
        <h3>Privacy & storage</h3>
        <div className="privacy-item">
          <ShieldCheck size={18} />
          <div>
            <strong>Local requests, no telemetry</strong>
            <p>
              Model requests stay on loopback. Configure your external Ollama runtime with cloud
              features disabled.
            </p>
          </div>
        </div>
        <div className="privacy-item">
          <HardDrive size={18} />
          <div>
            <strong>Transactional local storage</strong>
            <p>
              SQLite stores sessions, checkpoints and task state. Legacy JSON is backed up during
              migration. Data is not encrypted.
            </p>
            <code>{dataPath}</code>
          </div>
        </div>
        <div className="privacy-item">
          <Terminal size={18} />
          <div>
            <strong>Isolated execution on macOS</strong>
            <p>
              Compiler and training processes run with network denied, restricted file access and a
              clean environment. Other platforms fail closed for process execution.
            </p>
          </div>
        </div>
      </div>
      <McpSettings profiles={draft.mcpServers} onChange={(mcpServers) => update({ mcpServers })} />
      <div className="about-line">
        <Cpu size={18} />
        <strong>Forge</strong>
        <span>0.2.0 · MIT License</span>
        <span>{platform}</span>
      </div>
    </div>
  );
}
