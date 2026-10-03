import { useEffect, useState } from 'react';
import {
  FlaskConical,
  Layers3,
  Plus,
  Download,
  FileCode2,
  ChevronDown,
  Check,
  Trash2,
  BookmarkPlus,
  ArrowRight,
  CircleHelp,
  FolderOpen,
  LockKeyhole,
  Square,
  Zap,
  CheckCheck,
} from 'lucide-react';
import type { AppState, TrainingConfig } from '../shared/types';
import { api } from './api';
import { Badge, Button, PageHeader, Modal } from './components/ui';
export default function Training({
  state,
  training,
  log,
  notify,
  onExamples,
  onStart,
}: {
  state: AppState;
  training: boolean;
  log: string;
  notify: (e: unknown) => void;
  onExamples: (examples: AppState['examples']) => void;
  onStart: () => void;
}) {
  const [tab, setTab] = useState<'dataset' | 'train'>('dataset'),
    [adding, setAdding] = useState(false),
    [prompt, setPrompt] = useState(''),
    [response, setResponse] = useState('');
  const [config, setConfig] = useState<TrainingConfig>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('forge.training.config') ?? 'null');
      if (
        saved &&
        typeof saved.executable === 'string' &&
        typeof saved.modelPath === 'string' &&
        ['iterations', 'learningRate', 'batchSize'].every((k) => typeof saved[k] === 'number')
      )
        return saved;
    } catch {}
    return {
      executable: '',
      modelPath: '',
      iterations: 100,
      learningRate: 0.00001,
      batchSize: 1,
    };
  });
  useEffect(() => {
    try {
      localStorage.setItem('forge.training.config', JSON.stringify(config));
    } catch {}
  }, [config]);
  async function save() {
    try {
      onExamples(await api.saveExample(prompt, response));
      setAdding(false);
      setPrompt('');
      setResponse('');
    } catch (e) {
      notify(e);
    }
  }
  async function pick(key: 'executable' | 'modelPath') {
    try {
      const value = await api.pickPath(key === 'executable' ? 'file' : 'directory');
      if (value) setConfig((old) => ({ ...old, [key]: value }));
    } catch (e) {
      notify(e);
    }
  }
  async function start() {
    try {
      onStart();
      await api.train(config);
    } catch (e) {
      notify(e);
    }
  }
  const uniqueCount = new Set(
    state.examples.filter((e) => e.reviewed !== false).map((e) => e.prompt.trim()),
  ).size;
  return (
    <div className="page-inner">
      <PageHeader
        eyebrow="BUILT TO GET BETTER"
        title="Teach it your way."
        description="Turn your best work into better local models. Curate first. Train with intention."
      />
      <div className="training-banner">
        <div>
          <Badge tone="amber">
            <FlaskConical size={12} />
            EXPERIMENTAL
          </Badge>
          <h2>
            Small lessons.
            <br />
            Lasting improvements.
          </h2>
          <p>
            Your patterns, your conventions, your code.
            <br />A training loop that belongs to you.
          </p>
        </div>
        <div className="training-art">
          <div className="training-ring" />
          <Layers3 size={66} strokeWidth={1} />
          <span className="training-spark">+</span>
        </div>
      </div>
      <div className="training-stats">
        <div>
          <span>CURATED EXAMPLES</span>
          <strong>
            {state.examples.length.toString().padStart(2, '0')}
            <small>saved locally</small>
          </strong>
        </div>
        <div>
          <span>TRAINING METHOD</span>
          <strong>
            LoRA<small>MLX · Apple Silicon</small>
          </strong>
        </div>
        <div>
          <span>DATA OWNERSHIP</span>
          <strong>
            100%<small>on your machine</small>
          </strong>
        </div>
      </div>
      <div className="training-tabs">
        <button className={tab === 'dataset' ? 'active' : ''} onClick={() => setTab('dataset')}>
          Dataset<Badge>{state.examples.length}</Badge>
        </button>
        <button className={tab === 'train' ? 'active' : ''} onClick={() => setTab('train')}>
          Train a model{training && <span className="tiny-dot green" />}
        </button>
      </div>
      {tab === 'dataset' ? (
        <>
          <div className="section-heading">
            <div>
              <h3>Good examples make the difference.</h3>
              <p>Save agent responses or add reviewed prompt–answer pairs.</p>
            </div>
            <div className="inline-actions">
              <Button
                onClick={async () => {
                  try {
                    const path = await api.exportDataset();
                    if (path) notify(`Dataset exported to ${path}`);
                  } catch (e) {
                    notify(e);
                  }
                }}
                disabled={uniqueCount < 5}
              >
                <Download size={14} />
                Export
              </Button>
              <Button primary onClick={() => setAdding(true)}>
                <Plus size={14} />
                Add example
              </Button>
            </div>
          </div>
          {state.examples.length ? (
            <div className="examples-list">
              {state.examples.map((example) => (
                <details key={example.id} className="example">
                  <summary>
                    <FileCode2 size={16} />
                    <span>{example.prompt}</span>
                    <Badge>{example.reviewed === false ? 'Draft' : 'Reviewed'}</Badge>
                    <ChevronDown size={14} />
                  </summary>
                  {example.reviewed === false && (
                    <button
                      className="button"
                      style={{ marginTop: 14 }}
                      onClick={async () => {
                        try {
                          onExamples(await api.reviewExample(example.id, true));
                        } catch (error) {
                          notify(error);
                        }
                      }}
                    >
                      <Check size={13} />
                      Mark reviewed
                    </button>
                  )}
                  <strong>Prompt</strong>
                  <pre>{example.prompt}</pre>
                  <strong>Response</strong>
                  <pre>{example.response}</pre>
                  <button
                    className="text-button danger"
                    onClick={async () => {
                      try {
                        onExamples(await api.deleteExample(example.id));
                      } catch (e) {
                        notify(e);
                      }
                    }}
                  >
                    <Trash2 size={13} />
                    Remove example
                  </button>
                </details>
              ))}
            </div>
          ) : (
            <div className="empty-state compact">
              <BookmarkPlus size={30} />
              <h3>Your best answers belong here.</h3>
              <p>
                Start with examples you’ve checked yourself.
                <br />
                Nothing is added automatically.
              </p>
              <button className="text-button" onClick={() => setAdding(true)}>
                Add your first example
                <ArrowRight size={14} />
              </button>
            </div>
          )}
          <div className="info-box">
            <CircleHelp size={17} />
            <span>
              Export needs 5 distinct prompts, grouped into training, validation and held-out test
              sets. Use a larger, diverse dataset for useful training. Remove secrets and verify
              every answer.
            </span>
          </div>
        </>
      ) : (
        <div className="settings-card training-config">
          <h3>Local MLX training</h3>
          <p className="muted-text">
            Requires Apple Silicon, an installed mlx_lm.lora executable, and a downloaded MLX-format
            model. This launches a real training process.
          </p>
          <label>
            MLX executable
            <div className="input-picker">
              <input
                placeholder="/path/to/venv/bin/mlx_lm.lora"
                value={config.executable}
                onChange={(e) => setConfig({ ...config, executable: e.target.value })}
              />
              <button onClick={() => pick('executable')} title="Choose MLX executable">
                <FolderOpen size={16} />
              </button>
            </div>
          </label>
          <label>
            Local model directory
            <div className="input-picker">
              <input
                placeholder="/path/to/local-mlx-model"
                value={config.modelPath}
                onChange={(e) => setConfig({ ...config, modelPath: e.target.value })}
              />
              <button onClick={() => pick('modelPath')} title="Choose model directory">
                <FolderOpen size={16} />
              </button>
            </div>
          </label>
          <div className="form-row">
            <label>
              Iterations
              <input
                type="number"
                min="1"
                value={config.iterations}
                onChange={(e) => setConfig({ ...config, iterations: Number(e.target.value) })}
              />
            </label>
            <label>
              Learning rate
              <input
                type="number"
                step="0.00001"
                value={config.learningRate}
                onChange={(e) => setConfig({ ...config, learningRate: Number(e.target.value) })}
              />
            </label>
            <label>
              Batch size
              <input
                type="number"
                min="1"
                max="32"
                value={config.batchSize}
                onChange={(e) => setConfig({ ...config, batchSize: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="info-box">
            <LockKeyhole size={17} />
            <span>
              Model downloads and reporting are disabled through offline environment settings. Run
              only a trusted MLX executable. Adapters are saved locally; evaluation and Ollama
              import are manual in v0.2.
            </span>
          </div>
          <Button
            primary
            disabled={!training && (uniqueCount < 5 || !config.executable || !config.modelPath)}
            onClick={() => (training ? api.stopTraining().catch(notify) : start())}
          >
            {training ? (
              <>
                <Square size={14} />
                Stop training
              </>
            ) : (
              <>
                <Zap size={15} />
                Start local training
              </>
            )}
          </Button>
          {uniqueCount < 5 && (
            <small className="muted-text">
              Add {5 - uniqueCount} more distinct prompts to enable training.
            </small>
          )}
          {log && <pre className="training-log">{log}</pre>}
        </div>
      )}
      {!!state.jobs?.length && (
        <div className="settings-card">
          <h3>Training history</h3>
          {state.jobs.slice(0, 10).map((job) => (
            <div key={job.id} className="privacy-item">
              <div>
                <strong>
                  {new Date(job.startedAt).toLocaleString()} · {job.status}
                </strong>
                <p>{job.message}</p>
                <code>{job.path}</code>
              </div>
            </div>
          ))}
        </div>
      )}
      {adding && (
        <Modal title="Add a reviewed example" onClose={() => setAdding(false)}>
          <div className="example-form">
            <p>Include enough context for the answer to stand on its own.</p>
            <label>
              Prompt
              <textarea
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="The task, constraints, and relevant code…"
              />
            </label>
            <label>
              Ideal response
              <textarea
                rows={7}
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                placeholder="A correct, complete answer you’ve verified…"
              />
            </label>
            <Button primary disabled={!prompt.trim() || !response.trim()} onClick={save}>
              <CheckCheck size={15} />
              Save reviewed example
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
