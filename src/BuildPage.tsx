import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Database,
  ExternalLink,
  Monitor,
  Play,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Square,
  Tablet,
  Terminal,
} from 'lucide-react';
import type { DevelopmentProcess, ProductArchitecture, Workspace } from '../shared/types';
import { api } from './api';
import { Badge, Button, PageHeader } from './components/ui';

type ScriptList = Awaited<ReturnType<typeof api.packageScripts>>;
type Viewport = 'desktop' | 'tablet' | 'phone';

export default function BuildPage({
  workspace,
  onError,
}: {
  workspace: Workspace | null;
  onError: (error: unknown) => void;
}) {
  const [scripts, setScripts] = useState<ScriptList>();
  const [processes, setProcesses] = useState<DevelopmentProcess[]>([]);
  const [analysis, setAnalysis] = useState<ProductArchitecture>();
  const [selectedUrl, setSelectedUrl] = useState('');
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [frameKey, setFrameKey] = useState(0);
  const [working, setWorking] = useState('');

  const refresh = useCallback(async () => {
    if (!workspace) return;
    try {
      const [nextScripts, nextProcesses, nextAnalysis] = await Promise.all([
        api.packageScripts(),
        api.developmentProcesses(),
        api.productArchitecture(),
      ]);
      setScripts(nextScripts);
      setProcesses(nextProcesses);
      setAnalysis(nextAnalysis);
      const urls = nextProcesses.flatMap((item) => item.urls);
      setSelectedUrl((current) => (urls.includes(current) ? current : (urls[0] ?? '')));
    } catch (error) {
      onError(error);
    }
  }, [workspace?.path, onError]);

  useEffect(() => {
    setScripts(undefined);
    setProcesses([]);
    setAnalysis(undefined);
    setSelectedUrl('');
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!workspace) return;
    const timer = setInterval(() => {
      void api
        .developmentProcesses()
        .then((next) => {
          setProcesses(next);
          const urls = next.flatMap((item) => item.urls);
          setSelectedUrl((current) => (urls.includes(current) ? current : (urls[0] ?? '')));
        })
        .catch(onError);
    }, 1_500);
    return () => clearInterval(timer);
  }, [workspace?.path, onError]);

  const localUrl = useMemo(() => {
    try {
      const url = new URL(selectedUrl);
      return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
        ? url.toString()
        : '';
    } catch {
      return '';
    }
  }, [selectedUrl]);

  async function act(label: string, action: () => Promise<unknown>) {
    setWorking(label);
    try {
      await action();
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      setWorking('');
    }
  }

  if (!workspace)
    return (
      <div className="page-content build-page">
        <PageHeader
          eyebrow="DEVELOPMENT"
          title="Build loop"
          description="Open a workspace first."
        />
      </div>
    );

  return (
    <div className="page-content build-page">
      <PageHeader
        eyebrow="DEVELOPMENT"
        title="Visible build loop"
        description="Run the project, inspect live output and verify the local product beside your agent."
      />

      <section className="build-grid">
        <div className="build-column">
          <div className="build-section-heading">
            <div>
              <Terminal size={16} />
              <strong>Processes</strong>
            </div>
            <Button onClick={() => void refresh()} disabled={Boolean(working)}>
              <RefreshCw size={13} />
              Refresh
            </Button>
          </div>
          <div className="script-launcher">
            {(scripts?.scripts ?? []).map((script) => (
              <button
                key={script.name}
                className="script-card"
                disabled={Boolean(working)}
                onClick={() =>
                  void act(`start:${script.name}`, () => api.startDevelopmentProcess(script.name))
                }
              >
                <Play size={13} />
                <span>
                  <strong>{script.name}</strong>
                  <small>{script.command}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="process-list">
            {processes.map((process) => (
              <article className="process-card" key={process.id}>
                <header>
                  <div>
                    <span className={`tiny-dot ${process.running ? 'green' : 'muted'}`} />
                    <strong>pnpm {process.script}</strong>
                  </div>
                  <Badge tone={process.running ? 'green' : 'muted'}>
                    {process.running ? 'running' : `exit ${process.exitCode ?? 'stopped'}`}
                  </Badge>
                </header>
                <div className="process-meta">
                  {process.pid && <span>PID {process.pid}</span>}
                  <span>{process.health}</span>
                  {process.ports.length > 0 && <span>port {process.ports.join(', ')}</span>}
                  {process.recovered && <span>recovered after restart</span>}
                  <span>{new Date(process.startedAt).toLocaleTimeString()}</span>
                </div>
                {process.urls.map((url) => (
                  <button className="process-url" key={url} onClick={() => setSelectedUrl(url)}>
                    <ExternalLink size={12} />
                    {url}
                  </button>
                ))}
                <pre className="process-log">{process.output || 'Waiting for output…'}</pre>
                <footer>
                  <Button
                    disabled={Boolean(working)}
                    onClick={() =>
                      void act(`restart:${process.id}`, () =>
                        api.restartDevelopmentProcess(process.id),
                      )
                    }
                  >
                    <RotateCcw size={12} />
                    Restart
                  </Button>
                  <Button
                    disabled={!process.running || Boolean(working)}
                    onClick={() =>
                      void act(`stop:${process.id}`, () => api.stopDevelopmentProcess(process.id))
                    }
                  >
                    <Square size={12} />
                    Stop
                  </Button>
                </footer>
              </article>
            ))}
            {!processes.length && (
              <div className="build-empty">
                Start a package script to see logs and preview URLs.
              </div>
            )}
          </div>
        </div>

        <div className="build-column preview-column">
          <div className="build-section-heading">
            <div>
              <Monitor size={16} />
              <strong>Local preview</strong>
            </div>
            <div className="viewport-controls" aria-label="Preview viewport">
              <button
                className={viewport === 'desktop' ? 'active' : ''}
                onClick={() => setViewport('desktop')}
                title="Desktop"
              >
                <Monitor size={14} />
              </button>
              <button
                className={viewport === 'tablet' ? 'active' : ''}
                onClick={() => setViewport('tablet')}
                title="Tablet"
              >
                <Tablet size={14} />
              </button>
              <button
                className={viewport === 'phone' ? 'active' : ''}
                onClick={() => setViewport('phone')}
                title="Phone"
              >
                <Smartphone size={14} />
              </button>
              <button onClick={() => setFrameKey((value) => value + 1)} title="Reload preview">
                <RefreshCw size={14} />
              </button>
              <button
                disabled={!localUrl}
                onClick={() => void api.openBrowser(localUrl).catch(onError)}
                title="Open shared agent browser"
              >
                <ExternalLink size={14} />
              </button>
            </div>
          </div>
          <div className={`preview-stage ${viewport}`}>
            {localUrl ? (
              <iframe
                key={`${localUrl}:${frameKey}`}
                src={localUrl}
                title="Local project preview"
                sandbox="allow-scripts allow-forms allow-same-origin allow-modals"
              />
            ) : (
              <div className="preview-empty">
                <Activity size={28} />
                <strong>No local URL detected</strong>
                <span>Start a dev script that prints a localhost URL.</span>
              </div>
            )}
          </div>

          <div className="product-summary">
            <div className="build-section-heading">
              <div>
                <Database size={16} />
                <strong>T3 and product model</strong>
              </div>
            </div>
            <div className="product-metrics">
              <span>
                <strong>{analysis?.trpc.procedures.length ?? 0}</strong> procedures
              </span>
              <span>
                <strong>{analysis?.database.models.length ?? 0}</strong> data models
              </span>
              <span>
                <strong>{analysis?.contracts.length ?? 0}</strong> contracts
              </span>
              <span className={(analysis?.migrations.destructive.length ?? 0) ? 'danger' : ''}>
                <strong>{analysis?.migrations.destructive.length ?? 0}</strong> destructive
                migrations
              </span>
            </div>
            <div className="detected-stack">
              {analysis?.detected.map((item) => (
                <Badge key={item}>{item}</Badge>
              ))}
            </div>
            <Button
              onClick={() => void act('sqlite', () => api.createDisposableSqlite())}
              disabled={Boolean(working)}
            >
              <Database size={13} />
              Create disposable SQLite
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
