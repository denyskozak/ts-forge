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
} from 'lucide-react';
import { api } from './api';
import type { Settings, ConnectionTest } from '../shared/types';
export default function SettingsPage({
  settings,
  dataPath,
  platform,
  onSave,
}: {
  settings: Settings;
  dataPath: string;
  platform: string;
  onSave: (settings: Settings) => void;
}) {
  const [draft, setDraft] = useState(settings),
    [testing, setTesting] = useState(false),
    [result, setResult] = useState<ConnectionTest>();
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
  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="eyebrow">MAKE YOURSELF AT HOME</div>
        <h1>Your workspace, your rules.</h1>
        <p>Connect a local model, shape its context, and keep control of your code.</p>
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
            value={draft.speechLanguage}
            onChange={(e) =>
              update({ speechLanguage: e.target.value as Settings['speechLanguage'] })
            }
          >
            <option value="auto">System language</option>
            <option value="ru-RU">Русский</option>
            <option value="en-US">English</option>
          </select>
          <small>
            Voice input requires a local Chromium speech pack. Forge never falls back to remote
            speech recognition.
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
      <div className="about-line">
        <Cpu size={18} />
        <strong>Forge</strong>
        <span>0.2.0 · MIT License</span>
        <span>{platform}</span>
      </div>
    </div>
  );
}
