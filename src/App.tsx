import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Map as MapIcon,
  RotateCcw,
  ArrowUp,
  ArrowUpRight,
  ArrowRight,
  Plus,
  MessageSquare,
  Cpu,
  Layers3,
  FlaskConical,
  Settings2,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  LockKeyhole,
  GitBranch,
  FileCode2,
  Terminal,
  Check,
  X,
  RefreshCw,
  Square,
  CircleHelp,
  Search,
  HardDrive,
  AlertCircle,
  LoaderCircle,
  Trash2,
  Activity,
} from 'lucide-react';
import { Mark, Badge, Button, PageHeader, Modal } from './components/ui';
import { MessageHistory } from './components/MessageHistory';
import { Diff } from './components/Diff';
import { VoiceInput } from './components/VoiceInput';
import { TaskPanel, ChangeSetSummary } from './components/TaskPanel';
import { TaskTimeline } from './components/TaskTimeline';
import Training from './TrainingPage';
import { useAgentEvents } from './hooks/useAgentEvents';
import { initialRunView, runViewReducer } from './state/run-view';
import SettingsPage from './SettingsPage';
import BuildPage from './BuildPage';
import { api, isDesktop } from './api';
import {
  DEFAULT_SETTINGS,
  SKILLS,
  type AppState,
  type Settings,
  type Page,
  type LocalModel,
  type Session,
} from '../shared/types';
const NAV = [
  { id: 'agent', label: 'Workspace', icon: MessageSquare },
  { id: 'build', label: 'Build loop', icon: Terminal },
  { id: 'models', label: 'Local models', icon: Cpu },
  { id: 'skills', label: 'Skills', icon: Layers3 },
  { id: 'training', label: 'Training lab', icon: FlaskConical },
] as const;
const skillGlyph = (id: (typeof SKILLS)[number]['id']) =>
  id === 'typescript'
    ? 'TS'
    : id === 'react'
      ? '✳'
      : id === 'react-native'
        ? 'RN'
        : id === 'react-three'
          ? '3D'
          : id === 'git'
            ? 'GIT'
            : id === 'git-review'
              ? 'DIFF'
              : id === 'contributing'
                ? 'PR'
                : id.startsWith('mcp-')
                  ? 'MCP'
                  : 'N';
const initial: AppState = {
  settings: DEFAULT_SETTINGS,
  workspace: null,
  workspaces: [],
  sessions: [],
  examples: [],
  platform: '',
  dataPath: '',
};
export default function App() {
  const [state, setState] = useState<AppState>(initial),
    [page, setPage] = useState<Page>('agent');
  const [models, setModels] = useState<LocalModel[]>([]),
    [connection, setConnection] = useState<'checking' | 'online' | 'offline'>('checking');
  const [modelError, setModelError] = useState(''),
    [toast, setToast] = useState('');
  const [runView, dispatchRun] = useReducer(runViewReducer, initialRunView);
  const {
    messages,
    sessionId,
    busy,
    status,
    stream,
    approval,
    clarification,
    changes,
    task,
    changeSets,
    checkpoint,
    toolCount,
  } = runView;
  const [prompt, setPrompt] = useState('');
  const [customAnswer, setCustomAnswer] = useState('');
  const [answerPending, setAnswerPending] = useState(false);
  useEffect(() => {
    setCustomAnswer('');
    setAnswerPending(false);
  }, [clarification?.id]);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightTab, setRightTab] = useState<'context' | 'changes'>('context'),
    [file, setFile] = useState<{ path: string; content: string }>();
  const [trainingLog, setTrainingLog] = useState(''),
    [training, setTraining] = useState(false),
    [help, setHelp] = useState(false);
  const activeSkills = SKILLS.filter(
    (skill) => skill.required || state.settings.skills.includes(skill.id),
  );
  const stickToBottom = useRef(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const endRef = useRef<HTMLDivElement>(null),
    promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!clarification) return;
    const Audio =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Audio) return;
    const context = new Audio();
    if (typeof context.createOscillator !== 'function') {
      void context.close().catch(() => {});
      return;
    }
    const oscillator = context.createOscillator(),
      gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(740, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(980, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.25);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.26);
    oscillator.onended = () => {
      void context.close();
    };
    return () => {
      void context.close().catch(() => {});
    };
  }, [clarification?.id]);
  const notify = useCallback(
    (error: unknown) => setToast(error instanceof Error ? error.message : String(error)),
    [],
  );
  async function refreshModels() {
    setConnection('checking');
    try {
      const list = await api.models();
      setModels(list);
      setConnection('online');
      setModelError('');
    } catch (e) {
      setConnection('offline');
      setModels([]);
      setModelError((e as Error).message);
    }
  }
  useEffect(() => {
    void api
      .state()
      .then((data) => {
        setState(data);
        if (data.recovery?.length) setToast(data.recovery.join(' '));
        dispatchRun({ type: 'hydrate', data });
        if (data.jobs?.some((job) => job.status === 'running')) setTraining(true);
      })
      .catch(notify);
    if (isDesktop) void refreshModels();
    else setConnection('offline');
  }, []);
  useAgentEvents((event) => {
    dispatchRun(event);
    if (event.type === 'map')
      setState((old) => ({
        ...old,
        workspaces: old.workspaces.map((item) =>
          item.path === event.map.workspace ? { ...item, analyzed: true } : item,
        ),
        workspace:
          old.workspace?.path === event.map.workspace
            ? { ...old.workspace, map: event.map }
            : old.workspace,
      }));
    if (event.type === 'task') {
      setState((old) => ({
        ...old,
        sessions: old.sessions.map((session) =>
          session.task?.runId === event.task.runId ? { ...session, task: event.task } : session,
        ),
      }));
    }
    if (event.type === 'approval') {
      setRightOpen(true);
      setRightTab('changes');
    }
    if (event.type === 'error') {
      setToast(event.error);
    }
    if (event.type === 'done') {
      setState((old) => ({
        ...old,
        sessions: [event.session, ...old.sessions.filter((s) => s.id !== event.session.id)],
      }));
      void api.state().then(setState).catch(notify);
    }
    if (event.type === 'training') {
      setTraining(event.running);
      if (!event.running) void api.state().then(setState).catch(notify);
      setTrainingLog((old) => (old + event.text).slice(-60000));
    }
  });
  useEffect(() => {
    if (!stickToBottom.current) return;
    const frame = requestAnimationFrame(() =>
      endRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [messages, stream]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        if (!busy) newSession();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPage('agent');
        promptRef.current?.focus();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [busy]);
  async function saveSettings(value: Settings) {
    try {
      const settings = await api.settings(value);
      setState((old) => ({ ...old, settings }));
      return true;
    } catch (e) {
      notify(e);
      return false;
    }
  }
  async function openWorkspace() {
    setAnalyzing(true);
    try {
      const workspace = await api.openWorkspace();
      if (workspace) {
        setState((old) => ({
          ...old,
          workspace,
          workspaces: [
            {
              path: workspace.path,
              name: workspace.name,
              active: true,
              analyzed: Boolean(workspace.map),
            },
            ...old.workspaces
              .filter((item) => item.path !== workspace.path)
              .map((item) => ({ ...item, active: false })),
          ],
        }));
        setWorkspaceMenu(false);
        newSession();
      }
    } catch (e) {
      notify(e);
    } finally {
      setAnalyzing(false);
    }
  }
  async function selectWorkspace(path: string) {
    if (busy || path === state.workspace?.path) return;
    setAnalyzing(true);
    try {
      const workspace = await api.selectWorkspace(path);
      setState((old) => ({
        ...old,
        workspace,
        workspaces: old.workspaces.map((item) => ({
          ...item,
          active: item.path === workspace.path,
          analyzed: item.path === workspace.path ? Boolean(workspace.map) : item.analyzed,
        })),
      }));
      setWorkspaceMenu(false);
      newSession();
    } catch (error) {
      notify(error);
    } finally {
      setAnalyzing(false);
    }
  }
  async function removeWorkspace(path: string) {
    if (busy) return;
    setAnalyzing(true);
    try {
      const workspace = await api.removeWorkspace(path);
      setState((old) => ({
        ...old,
        workspace,
        workspaces: old.workspaces
          .filter((item) => item.path !== path)
          .map((item) => ({ ...item, active: item.path === workspace?.path })),
      }));
      if (path === state.workspace?.path) newSession();
    } catch (error) {
      notify(error);
    } finally {
      setAnalyzing(false);
    }
  }
  function newSession() {
    dispatchRun({ type: 'select' });
    setPrompt('');
    setPage('agent');
  }
  function loadSession(session: Session) {
    if (busy) return;
    dispatchRun({ type: 'select', session });
    setPage('agent');
  }
  async function run() {
    if (!prompt.trim() || busy) return;
    if (!state.workspace) {
      notify('Open a project to give Forge context.');
      return;
    }
    if (!state.settings.model) {
      setPage('models');
      notify('Choose an installed local model first.');
      return;
    }
    const input = prompt;
    setPrompt('');
    dispatchRun({ type: 'start' });
    try {
      await api.run(input, sessionId);
    } catch (e) {
      dispatchRun({ type: 'start-failed' });
      setPrompt(input);
      notify(e);
    }
  }
  async function approve(allow: boolean) {
    if (!approval) return;
    try {
      await api.approve(approval.id, allow);
      dispatchRun({ type: 'approved' });
    } catch (e) {
      notify(e);
    }
  }
  async function answerClarification(optionId: string) {
    if (!clarification || answerPending) return;
    setAnswerPending(true);
    try {
      await api.answerClarification(
        clarification.id,
        optionId,
        optionId === 'custom' ? customAnswer.trim() : undefined,
      );
      dispatchRun({ type: 'clarification-answered' });
    } catch (e) {
      notify(e);
    } finally {
      setAnswerPending(false);
    }
  }
  const capture = useCallback(
    async (messageId: string) => {
      try {
        if (!sessionId)
          throw new Error('Wait for the session to finish before capturing a training example.');
        const examples = await api.captureExample(sessionId, messageId);
        setState((old) => ({ ...old, examples }));
        setToast('Draft example with task context saved. Review it in Training lab before export.');
      } catch (e) {
        notify(e);
      }
    },
    [sessionId, notify],
  );
  const readFile = useCallback(
    async (path: string) => {
      try {
        setFile({ path, content: await api.readFile(path) });
      } catch (e) {
        notify(e);
      }
    },
    [notify],
  );
  const sessions = useMemo(
    () => state.sessions.filter((s) => s.workspace === state.workspace?.path),
    [state.sessions, state.workspace?.path],
  );
  const activeModel = models.find((m) => m.name === state.settings.model);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-space" />
        <div className="brand">
          <div className="brand-symbol">
            <Mark small />
          </div>
          <span>
            forge<span className="brand-dot">.</span>
          </span>
          <span className="version">ALPHA</span>
        </div>
        <button
          className="project-picker"
          onClick={() =>
            state.workspaces.length ? setWorkspaceMenu((open) => !open) : void openWorkspace()
          }
          disabled={busy}
        >
          <div className="project-icon">
            <FolderOpen size={17} />
          </div>
          <div>
            <strong>{state.workspace?.name || 'Your workspace'}</strong>
            <span>{state.workspace ? 'Local project' : 'Open a project to begin'}</span>
          </div>
          {analyzing ? <LoaderCircle size={14} className="spin" /> : <ChevronDown size={14} />}
        </button>
        {workspaceMenu && (
          <div className="workspace-menu">
            <div className="workspace-menu-heading">
              <span>WORKSPACES</span>
              <button className="icon-button" title="Add workspace" onClick={openWorkspace}>
                <Plus size={14} />
              </button>
            </div>
            {state.workspaces.map((item) => (
              <div className={`workspace-row ${item.active ? 'active' : ''}`} key={item.path}>
                <button onClick={() => selectWorkspace(item.path)} title={item.path}>
                  <FolderOpen size={14} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.analyzed ? 'TypeScript analysis ready' : 'Analysis pending'}
                    </small>
                  </span>
                </button>
                <button
                  className="workspace-remove"
                  title={`Remove ${item.name}`}
                  onClick={() => removeWorkspace(item.path)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button className="workspace-add" onClick={openWorkspace}>
              <Plus size={14} />
              Open another project
            </button>
          </div>
        )}
        <div className="nav-caption">BUILD</div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === 'training' ? (
                <span className="nav-new">LAB</span>
              ) : item.id === 'agent' ? (
                <kbd>⌘ K</kbd>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="session-heading">
          <span>RECENT SESSIONS</span>
          <button className="icon-button" title="New session" onClick={newSession} disabled={busy}>
            <Plus size={16} />
          </button>
        </div>
        <div className="session-list">
          {sessions.length ? (
            sessions.slice(0, 8).map((s) => (
              <button
                key={s.id}
                disabled={busy}
                className={`session-link ${sessionId === s.id ? 'selected' : ''}`}
                onClick={() => loadSession(s)}
              >
                <MessageSquare size={14} />
                <span>{s.title}</span>
              </button>
            ))
          ) : (
            <div className="session-empty">
              <span className="tiny-dot" />A little quiet here.
              <br />
              <span>Your next idea starts a session.</span>
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="private-card">
            <div className="private-icon">
              <ShieldCheck size={19} />
            </div>
            <div>
              <strong>Yours. And only yours.</strong>
              <p>
                Local models. Local files.
                <br />
                No account required.
              </p>
            </div>
            <span className="green-dot" />
          </div>
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => setPage('settings')}
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </button>
          <div className="sidebar-footer">
            <span className="avatar">F</span>
            <span>
              Personal workspace<small>Open source edition</small>
            </span>
            <button className="icon-button" title="Getting started" onClick={() => setHelp(true)}>
              <CircleHelp size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Personal</span>
            <ChevronRight size={13} />
            <strong>
              {page === 'agent'
                ? 'Workspace'
                : page === 'build'
                  ? 'Build loop'
                  : page === 'training'
                    ? 'Training lab'
                    : page === 'models'
                      ? 'Local models'
                      : page === 'skills'
                        ? 'Skills'
                        : 'Settings'}
            </strong>
            {page === 'agent' && (
              <span className="session-label">{sessionId ? 'Session' : 'New session'}</span>
            )}
          </div>
          <div className="top-actions">
            <span className="local-label">
              <LockKeyhole size={12} />
              LOCAL FIRST
            </span>
            <div className="divider" />
            <button
              className="icon-button"
              title="Toggle context panel"
              aria-label={rightOpen ? 'Hide context panel' : 'Show context panel'}
              aria-expanded={rightOpen}
              aria-controls="workspace-context"
              onClick={() => setRightOpen((open) => !open)}
            >
              {rightOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
            </button>
          </div>
        </header>
        <div className="body-row">
          <main className={`main-content ${page === 'agent' ? 'agent-content' : ''}`}>
            {page === 'agent' ? (
              <>
                <div className="session-toolbar">
                  <div>
                    <span className="tiny-dot orange" />{' '}
                    {busy ? status : 'A space to build something great'}
                  </div>
                  <button onClick={newSession} disabled={busy}>
                    <Plus size={14} />
                    New session
                  </button>
                </div>
                <div
                  className="conversation"
                  onScroll={(e) => {
                    const node = e.currentTarget;
                    stickToBottom.current =
                      node.scrollHeight - node.scrollTop - node.clientHeight < 100;
                  }}
                >
                  {!messages.length && !busy ? (
                    <div className="welcome">
                      <h1>
                        Good ideas deserve
                        <br />a <span>great build partner.</span>
                      </h1>
                    </div>
                  ) : (
                    <div className="message-list">
                      <MessageHistory
                        key={sessionId ?? 'new'}
                        messages={messages}
                        onCapture={capture}
                        onRead={readFile}
                      />
                      {busy && (
                        <article className="message assistant">
                          <div className="message-avatar">
                            <Mark small />
                          </div>
                          <div className="message-body">
                            <div className="message-heading">
                              <strong>Forge</strong>
                              <span className="working-status">
                                <LoaderCircle size={12} className="spin" />
                                {status}
                              </span>
                            </div>
                            {stream ? (
                              <div className="markdown">
                                <div className="stream-text">{stream}</div>
                              </div>
                            ) : (
                              <div className="thinking-dots">
                                <i />
                                <i />
                                <i />
                              </div>
                            )}
                          </div>
                        </article>
                      )}
                      <div ref={endRef} />
                    </div>
                  )}
                </div>
                <div className="composer-area">
                  <TaskTimeline
                    checkpoint={checkpoint}
                    toolCount={toolCount}
                    busy={busy}
                    onResume={() => {
                      if (!sessionId || busy) return;
                      dispatchRun({ type: 'start' });
                      void api.resume(sessionId).catch((error) => {
                        dispatchRun({ type: 'start-failed' });
                        notify(error);
                      });
                    }}
                  />
                  {task && (
                    <TaskPanel task={task} sessionId={sessionId} busy={busy} onError={notify} />
                  )}
                  {clarification && (
                    <div
                      className="clarification-card"
                      role="group"
                      aria-label="Forge question"
                      tabIndex={-1}
                    >
                      <div className="clarification-heading">
                        <CircleHelp size={18} />
                        <div>
                          <strong>{clarification.question}</strong>
                          <span>{clarification.reason}</span>
                        </div>
                      </div>
                      <div className="clarification-options">
                        {clarification.options.map((option) => (
                          <button
                            key={option.id}
                            disabled={answerPending}
                            onClick={() => void answerClarification(option.id)}
                          >
                            <strong>{option.label}</strong>
                            {option.description && <span>{option.description}</span>}
                          </button>
                        ))}
                      </div>
                      <form
                        className="clarification-custom"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void answerClarification('custom');
                        }}
                      >
                        <label htmlFor="custom-answer">Or write your own answer</label>
                        <textarea
                          id="custom-answer"
                          value={customAnswer}
                          onChange={(event) => setCustomAnswer(event.target.value)}
                          maxLength={2000}
                          rows={2}
                          disabled={answerPending}
                          placeholder="Your answer…"
                        />
                        <button
                          type="submit"
                          className="primary"
                          disabled={answerPending || !customAnswer.trim()}
                        >
                          Send answer
                        </button>
                      </form>
                    </div>
                  )}
                  {approval && (
                    <div className="approval-banner">
                      <ShieldCheck size={18} />
                      <div>
                        <strong>Your approval is needed</strong>
                        <span>
                          {approval.kind === 'write'
                            ? `Review changes to ${approval.change?.path}`
                            : approval.title}
                        </span>
                      </div>
                      <button onClick={() => approve(false)}>Decline</button>
                      <button className="approve-button" onClick={() => approve(true)}>
                        {approval.kind === 'write'
                          ? 'Apply change'
                          : approval.kind === 'changeset'
                            ? 'Apply changeset'
                            : approval.kind === 'web_search'
                              ? 'Search web'
                              : approval.kind === 'scaffold'
                                ? 'Create project'
                                : approval.kind === 'git'
                                  ? 'Run Git action'
                                  : approval.kind === 'package'
                                    ? 'Change packages'
                                    : approval.kind === 'process'
                                      ? 'Start process'
                                      : approval.kind === 'browser'
                                        ? 'Open browser'
                                        : approval.kind === 'mcp'
                                          ? 'Allow MCP action'
                                          : 'Run check'}
                        <Check size={14} />
                      </button>
                    </div>
                  )}
                  <div className={`composer ${busy ? 'is-busy' : ''}`}>
                    <textarea
                      ref={promptRef}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void run();
                        }
                      }}
                      placeholder="What would you like to build?"
                      aria-label="Message Forge"
                      rows={2}
                    />
                    <div className="composer-bottom">
                      <button className="context-button" onClick={openWorkspace} disabled={busy}>
                        <Plus size={16} />
                        <span>{state.workspace?.name || 'Add project'}</span>
                      </button>
                      <div className="composer-right">
                        <VoiceInput
                          language={state.settings.speechLanguage}
                          disabled={busy}
                          onError={setToast}
                          onTranscript={(text) => {
                            setPrompt((current) =>
                              current.trim() ? `${current.trimEnd()} ${text}` : text,
                            );
                            requestAnimationFrame(() => promptRef.current?.focus());
                          }}
                        />
                        <button className="model-button" onClick={() => setPage('models')}>
                          <span className={`tiny-dot ${activeModel ? 'green' : 'orange'}`} />
                          {state.settings.model || 'Select local model'}
                          <ChevronDown size={12} />
                        </button>
                        {busy ? (
                          <button
                            className="send-button stop"
                            onClick={() => api.stop().catch(notify)}
                            title="Stop agent"
                          >
                            <Square size={15} />
                          </button>
                        ) : (
                          <button
                            className="send-button"
                            disabled={!prompt.trim()}
                            onClick={run}
                            title="Send message"
                          >
                            <ArrowUp size={19} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="composer-footnote">
                    <span>
                      <LockKeyhole size={11} />
                      Your code stays on your machine.
                    </span>
                    <span>
                      <kbd>↵</kbd> to send <span className="footnote-dot">·</span>
                      <kbd>⇧ ↵</kbd> new line
                    </span>
                  </div>
                </div>
              </>
            ) : page === 'build' ? (
              <BuildPage workspace={state.workspace} onError={notify} />
            ) : page === 'models' ? (
              <div className="page-inner">
                <PageHeader
                  eyebrow="LOCAL INTELLIGENCE"
                  title="A mind of your own."
                  description="Choose the model behind your next build. Everything runs on your machine."
                />
                <div className="connection-card">
                  <div className="large-icon">
                    <Cpu size={24} />
                  </div>
                  <div>
                    <h3>
                      Ollama runtime{' '}
                      <Badge tone={connection === 'online' ? 'green' : 'amber'}>
                        {connection === 'online'
                          ? 'Connected'
                          : connection === 'checking'
                            ? 'Checking'
                            : 'Disconnected'}
                      </Badge>
                    </h3>
                    <code>{state.settings.endpoint}</code>
                  </div>
                  <button className="button" onClick={refreshModels}>
                    <RefreshCw size={14} className={connection === 'checking' ? 'spin' : ''} />
                    Refresh
                  </button>
                </div>
                {modelError && (
                  <div className="info-box">
                    <AlertCircle size={17} />
                    <span>
                      {isDesktop
                        ? 'Start Ollama locally, then refresh to discover your models.'
                        : 'Model discovery is available in the Electron app.'}
                    </span>
                  </div>
                )}
                <div className="section-heading">
                  <h3>Installed models</h3>
                  <span>{models.length} available</span>
                </div>
                {models.length ? (
                  <div className="model-grid">
                    {models.map((model) => (
                      <div
                        className={`model-card ${state.settings.model === model.name ? 'chosen' : ''}`}
                        key={model.name}
                      >
                        <div className="model-top">
                          <div className="large-icon">
                            <Cpu size={22} />
                          </div>
                          <Badge>{model.quantization || 'LOCAL'}</Badge>
                        </div>
                        <h3>{model.name}</h3>
                        <p>
                          {model.family} architecture · {model.parameters}
                        </p>
                        <div className="model-details">
                          <span>
                            <HardDrive size={14} />
                            {(model.size / 1e9).toFixed(1)} GB
                          </span>
                          <span>
                            <LockKeyhole size={12} />
                            On device
                          </span>
                        </div>
                        <Button
                          disabled={model.supportsTools === false}
                          primary={state.settings.model !== model.name}
                          onClick={() => saveSettings({ ...state.settings, model: model.name })}
                        >
                          {model.supportsTools === false ? (
                            'No tool support'
                          ) : state.settings.model === model.name ? (
                            <>
                              <Check size={15} />
                              Selected model
                            </>
                          ) : (
                            <>
                              Use this model
                              <ArrowRight size={15} />
                            </>
                          )}
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <Cpu size={34} />
                    <h3>
                      {connection === 'online'
                        ? 'Your model shelf is empty.'
                        : 'Bring your own intelligence.'}
                    </h3>
                    <p>
                      Install Ollama and download a model with tool-calling support.
                      <br />
                      Then return here to connect it to Forge.
                    </p>
                    <code>OLLAMA_NO_CLOUD=1 ollama serve</code>
                    <small>Model downloads are a separate, explicit setup step.</small>
                    <button className="text-button" onClick={() => setHelp(true)}>
                      Read the setup guide
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                )}
                <div className="info-box">
                  <ShieldCheck size={18} />
                  <span>
                    Only loopback connections and installed local models are accepted. Cloud-backed
                    model entries are excluded.
                  </span>
                </div>
              </div>
            ) : page === 'skills' ? (
              <div className="page-inner">
                <PageHeader
                  eyebrow="THE RIGHT KIND OF CONTEXT"
                  title="A little more specialized."
                  description="Choose framework skills for your project. Problem understanding, complete delivery, sustainable design, testing and MCP policies are always active."
                />
                <div className="section-heading">
                  <h3>Your toolkit</h3>
                  <Badge tone="amber">{activeSkills.length} active</Badge>
                </div>
                <div className="skills-grid">
                  {SKILLS.map((skill) => (
                    <div
                      className={`skill-card ${skill.required || state.settings.skills.includes(skill.id) ? 'enabled' : ''}`}
                      key={skill.id}
                    >
                      <div className="skill-card-top">
                        <span className={`skill-logo ${skill.id}`}>{skillGlyph(skill.id)}</span>
                        <button
                          disabled={skill.required}
                          title={skill.required ? 'Required in every agent run' : undefined}
                          aria-label={`Toggle ${skill.name}`}
                          aria-pressed={skill.required || state.settings.skills.includes(skill.id)}
                          className={`toggle ${skill.required || state.settings.skills.includes(skill.id) ? 'on' : ''}`}
                          onClick={() =>
                            saveSettings({
                              ...state.settings,
                              skills:
                                skill.required || state.settings.skills.includes(skill.id)
                                  ? state.settings.skills.filter((id) => id !== skill.id)
                                  : [...state.settings.skills, skill.id],
                            })
                          }
                        >
                          <span />
                        </button>
                      </div>
                      <h2>{skill.name}</h2>
                      <p>{skill.description}</p>
                      <div className="tags">
                        {skill.tags.map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                      <details className="skill-instructions">
                        <summary>
                          View instructions
                          <ChevronDown size={14} />
                        </summary>
                        <p>{skill.instructions}</p>
                      </details>
                    </div>
                  ))}
                </div>
                <div className="roadmap-card">
                  <div className="large-icon">
                    <Layers3 size={22} />
                  </div>
                  <div>
                    <h3>Start focused. Grow deliberately.</h3>
                    <p>
                      TypeScript is the first specialization. The harness keeps language guidance
                      separate from tools, ready for more.
                    </p>
                  </div>
                  <Badge>v0.2</Badge>
                </div>
              </div>
            ) : page === 'training' ? (
              <Training
                state={state}
                training={training}
                log={trainingLog}
                notify={notify}
                onExamples={(examples) => setState((old) => ({ ...old, examples }))}
                onStart={() => setTrainingLog('')}
              />
            ) : (
              <SettingsPage
                settings={state.settings}
                dataPath={state.dataPath}
                platform={state.platform}
                onSave={async (value) => {
                  if (await saveSettings(value)) {
                    setToast('Settings saved locally.');
                    void refreshModels();
                  }
                }}
              />
            )}
          </main>
          {rightOpen && (
            <aside id="workspace-context" className="context-panel">
              <div className="context-tabs">
                <button
                  className={rightTab === 'context' ? 'active' : ''}
                  onClick={() => setRightTab('context')}
                >
                  Context
                </button>
                <button
                  className={rightTab === 'changes' ? 'active' : ''}
                  onClick={() => setRightTab('changes')}
                >
                  Changes{changes.length > 0 && <span>{changes.length}</span>}
                </button>
                <button
                  className="icon-button"
                  title="Close context"
                  onClick={() => setRightOpen(false)}
                >
                  <PanelRightClose size={15} />
                </button>
              </div>
              {rightTab === 'context' ? (
                <>
                  <div className="context-section">
                    <div className="context-label">
                      WORKSPACE
                      <FolderOpen size={13} />
                    </div>
                    {state.workspace ? (
                      <>
                        <button className="workspace-name" disabled={busy} onClick={openWorkspace}>
                          <span className="tiny-dot green" />
                          {state.workspace.name}
                          <ChevronDown size={12} />
                        </button>
                        <div className="file-tree">
                          {state.workspace.files.slice(0, 60).map((f) => (
                            <button key={f} onClick={() => readFile(f)} title={f}>
                              <FileCode2 size={13} />
                              <span>{f}</span>
                            </button>
                          ))}
                          {state.workspace.files.length > 60 && (
                            <span className="file-count">
                              + {state.workspace.files.length - 60} more files
                            </span>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="context-empty">
                        <div className="folder-outline">
                          <FolderOpen size={25} />
                        </div>
                        <strong>A home for your ideas</strong>
                        <p>
                          Open a project to give your agent
                          <br />
                          the context it needs.
                        </p>
                        <button className="button" onClick={openWorkspace}>
                          <Plus size={14} />
                          Open project
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="context-section">
                    <div className="context-label">
                      PROJECT MAP
                      <MapIcon size={13} />
                    </div>
                    {state.workspace?.map ? (
                      <div className="project-map-summary">
                        <strong>
                          {state.workspace.map.indexed} indexed files · {state.workspace.map.format}
                        </strong>
                        <p>
                          {state.workspace.map.mentalModel.frameworks
                            .map((framework) => framework.name)
                            .join(' · ') || 'Framework not detected'}
                        </p>
                        <span>
                          {state.workspace.map.mentalModel.entrypoints.length} entrypoints ·{' '}
                          {state.workspace.map.mentalModel.routes.length} routes ·{' '}
                          {state.workspace.map.mentalModel.relationships.length} import links
                        </span>
                        {state.workspace.map.mentalModel.scene && (
                          <p>
                            3D scene: {state.workspace.map.mentalModel.scene.canvases.length} Canvas
                            files · {state.workspace.map.mentalModel.scene.frameFiles.length}{' '}
                            frame-loop files ·{' '}
                            {state.workspace.map.mentalModel.scene.assetFiles.length} asset-loader
                            files
                          </p>
                        )}
                        <p>{state.workspace.map.formatSource}</p>
                        <span>
                          ~{state.workspace.map.estimatedTokens.toLocaleString()} tokens · estimate
                        </span>
                        <p>
                          {state.workspace.map.complete
                            ? 'Scan complete'
                            : 'Partial index — limits or unreadable files'}
                        </p>
                        <button
                          className="text-button"
                          onClick={() =>
                            setFile({
                              path: 'Project map',
                              content:
                                'MENTAL MODEL\n' +
                                JSON.stringify(state.workspace!.map!.mentalModel, null, 2) +
                                '\n\nPROJECT MAP\n' +
                                state.workspace!.map!.content +
                                '\n\n' +
                                state.workspace!.map!.warnings.join('\n'),
                            })
                          }
                        >
                          View project map
                          <ArrowUpRight size={12} />
                        </button>
                      </div>
                    ) : (
                      <p className="muted-text">Open a project to build its context map.</p>
                    )}
                    <button
                      className="text-button"
                      style={{ marginTop: 12, marginBottom: 22 }}
                      disabled={analyzing || busy || !state.workspace}
                      onClick={async () => {
                        setAnalyzing(true);
                        try {
                          await api.analyzeProject();
                        } catch (error) {
                          notify(error);
                        } finally {
                          setAnalyzing(false);
                        }
                      }}
                    >
                      <RefreshCw size={12} className={analyzing ? 'spin' : ''} />
                      {analyzing ? 'Analyzing…' : 'Refresh map'}
                    </button>
                    <div className="context-label">
                      TYPESCRIPT ANALYSIS
                      <Activity size={13} />
                    </div>
                    {state.workspace?.map?.typescript ? (
                      <div className="typescript-analysis-summary">
                        <div className="analysis-metrics">
                          <span>
                            <strong>{state.workspace.map.typescript.sourceFiles}</strong> sources
                          </span>
                          <span>
                            <strong>{state.workspace.map.typescript.testFiles}</strong> tests
                          </span>
                          <span>
                            <strong>{state.workspace.map.typescript.configFiles.length}</strong>{' '}
                            configs
                          </span>
                        </div>
                        <p>
                          TypeScript {state.workspace.map.typescript.version ?? 'version unknown'} ·{' '}
                          {state.workspace.map.typescript.compiler.strict
                            ? 'strict mode'
                            : 'strictness needs review'}
                        </p>
                        <div className="analysis-tools">
                          {state.workspace.map.typescript.recommendedTools.map((tool) => (
                            <span className={tool.status} key={tool.name}>
                              <span className="tiny-dot" />
                              {tool.name} · {tool.status}
                            </span>
                          ))}
                        </div>
                        <button
                          className="text-button"
                          onClick={() =>
                            setFile({
                              path: 'TypeScript workspace analysis',
                              content: JSON.stringify(state.workspace!.map!.typescript, null, 2),
                            })
                          }
                        >
                          View analysis
                          <ArrowUpRight size={12} />
                        </button>
                      </div>
                    ) : (
                      <p className="muted-text">
                        {analyzing ? 'Analyzing TypeScript workspace…' : 'Analysis is not ready.'}
                      </p>
                    )}
                    <div className="context-separator" />
                    <div className="context-label">
                      ACTIVE SKILLS
                      <span>{activeSkills.length}</span>
                    </div>
                    {activeSkills.map((s) => (
                      <div className="context-skill" key={s.id}>
                        <span className={`mini-skill ${s.id}`}>{skillGlyph(s.id)}</span>
                        <span>
                          {s.name}
                          <small>
                            {s.required
                              ? 'Mandatory harness guidance'
                              : s.id === 'typescript'
                                ? 'Language specialization'
                                : s.id === 'react'
                                  ? 'Component architecture'
                                  : 'Full-stack framework'}
                          </small>
                        </span>
                        <span className="tiny-dot green" />
                      </div>
                    ))}
                    <button className="text-button" onClick={() => setPage('skills')}>
                      <Plus size={12} />
                      Manage skills
                    </button>
                  </div>
                  <div className="context-section">
                    <div className="context-label">
                      HARNESS<Badge>v0.2</Badge>
                    </div>
                    <div className="harness-row">
                      <span>
                        <Search size={13} />
                        Read & search
                      </span>
                      <span>Allowed</span>
                    </div>
                    <div className="harness-row">
                      <span>
                        <FileCode2 size={13} />
                        Write files
                      </span>
                      <span className="amber-text">Ask first</span>
                    </div>
                    <div className="harness-row">
                      <span>
                        <Terminal size={13} />
                        TypeScript check
                      </span>
                      <span className="amber-text">Ask first</span>
                    </div>
                    <div className="harness-row">
                      <span>
                        <ArrowUpRight size={13} />
                        Network tools
                      </span>
                      <span>Off</span>
                    </div>
                  </div>
                  <div className="context-bottom">
                    <div className="local-device">
                      <div className="device-chip">
                        <Cpu size={19} />
                      </div>
                      <div>
                        <strong>Powered by your machine</strong>
                        <span>No cloud inference. No API bill.</span>
                      </div>
                    </div>
                    <div className="small-note">
                      <span className="tiny-dot green" />
                      Built to stay local.
                    </div>
                  </div>
                </>
              ) : (
                <div className="changes-list">
                  {changeSets?.map((set) => (
                    <ChangeSetSummary
                      key={set.id}
                      set={set}
                      busy={busy}
                      onRead={readFile}
                      onError={notify}
                    />
                  ))}
                  {changes.length ? (
                    changes.map((change) => (
                      <div className="change-card" key={change.id}>
                        <div>
                          <FileCode2 size={14} />
                          <strong>{change.path}</strong>
                        </div>
                        <Badge
                          tone={
                            change.status === 'applied'
                              ? 'green'
                              : change.status === 'pending'
                                ? 'amber'
                                : 'muted'
                          }
                        >
                          {change.status}
                        </Badge>
                        {change.status === 'applied' &&
                          (!change.changeSetId ||
                            (changeSets?.find((set) => set.id === change.changeSetId)?.changeIds
                              .length ?? 1) === 1) && (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={async () => {
                                try {
                                  await api.undoChange(change.id);
                                } catch (error) {
                                  notify(error);
                                }
                              }}
                            >
                              <RotateCcw size={12} />
                              Undo change
                            </button>
                          )}
                        <Diff before={change.before} after={change.after} />
                      </div>
                    ))
                  ) : (
                    <div className="context-empty">
                      <GitBranch size={28} />
                      <strong>Room for improvement.</strong>
                      <p>
                        Proposed file changes appear here
                        <br />
                        for you to review.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </aside>
          )}
        </div>
        <footer className="statusbar">
          <div>
            <span className={`tiny-dot ${connection === 'online' ? 'green' : 'muted'}`} />
            <button onClick={() => setPage('models')}>
              {connection === 'online'
                ? 'Ollama connected'
                : isDesktop
                  ? 'Ollama offline'
                  : 'Browser preview'}
            </button>
            <span className="status-separator" />
            <GitBranch size={12} />
            <span>{state.workspace?.name || 'No project open'}</span>
          </div>
          <div>
            <span>TypeScript-first</span>
            <span className="status-separator" />
            <ShieldCheck size={12} />
            <span>Local by design</span>
            <span className="status-version">v0.2.0</span>
          </div>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <AlertCircle size={17} />
          <span>{toast}</span>
          <button className="icon-button" onClick={() => setToast('')} title="Dismiss">
            <X size={15} />
          </button>
        </div>
      )}
      {file && (
        <Modal title={file.path} onClose={() => setFile(undefined)}>
          <pre className="file-preview">{file.content}</pre>
        </Modal>
      )}
      {help && (
        <Modal title="Your first local build" onClose={() => setHelp(false)}>
          <div className="setup-guide">
            <p>
              Forge connects to an Ollama runtime on this machine. You control which models and
              projects it can use.
            </p>
            <ol>
              <li>
                <strong>Install Ollama and a local model.</strong>
                <p>
                  Use a model that supports tools. Download its weights separately before working
                  offline.
                </p>
              </li>
              <li>
                <strong>Start Ollama with cloud features disabled.</strong>
                <code>OLLAMA_NO_CLOUD=1 ollama serve</code>
                <p>If Ollama is already running, configure and restart that instance.</p>
              </li>
              <li>
                <strong>Choose your model in Local models.</strong>
                <p>Refresh the list, select a model, and open a TypeScript project.</p>
              </li>
              <li>
                <strong>Build, review, repeat.</strong>
                <p>
                  Read and search tools work automatically. File writes and compiler runs wait for
                  your approval.
                </p>
              </li>
            </ol>
            <div className="info-box">
              <LockKeyhole size={18} />
              <span>
                Forge has no telemetry. Your local runtime and any compiler you approve are separate
                processes you control.
              </span>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
