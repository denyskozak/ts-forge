import { useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Database,
  FileCode2,
  Files,
  GitBranch,
  PackageCheck,
  Pencil,
  Search,
  Server,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type { Message } from '../../shared/types';
import { api } from '../api';

type Data = Record<string, unknown>;
type Tone = 'neutral' | 'success' | 'warning' | 'danger';
type Presentation = {
  title: string;
  summary?: string;
  tone: Tone;
  icon: ReactNode;
  metrics: string[];
  paths: string[];
  urls: string[];
  log?: string;
  failures: string[];
  screenshot?: string;
  liveBrowser: boolean;
};

const label = (name: string) =>
  name.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
const asText = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
const asStrings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 12)
    : [];
const unique = (items: string[]) => [...new Set(items.filter(Boolean))];
const pathFrom = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Data;
  return asText(record.path) ?? asText(record.file);
};
const pathsFrom = (value: Data) =>
  unique([
    ...[value.path, value.file].map(asText).filter((item): item is string => !!item),
    ...asStrings(value.paths),
    ...asStrings(value.files),
    ...(Array.isArray(value.entries) ? value.entries.map(pathFrom).filter(Boolean) : []),
    ...(Array.isArray(value.matches) ? value.matches.map(pathFrom).filter(Boolean) : []),
    ...(Array.isArray(value.evidence) ? value.evidence.map(pathFrom).filter(Boolean) : []),
  ] as string[]).filter((file) => !file.startsWith('/') && !file.split('/').includes('..'));
const count = (value: unknown) => (Array.isArray(value) ? value.length : undefined);
const statusTone = (status: string | undefined): Tone =>
  status && /pass|success|complete|applied|running|connected/i.test(status)
    ? 'success'
    : status && /fail|error|declin|cancel|unavailable|conflict/i.test(status)
      ? 'danger'
      : status && /stale|stopped|skipped|warning/i.test(status)
        ? 'warning'
        : 'neutral';

function parse(content: string): Data | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Data)
      : undefined;
  } catch {
    return undefined;
  }
}

function conciseToolError(content: string) {
  const detail = content.replace(/^Tool error:\s*/, '').trim();
  if (detail.startsWith('[')) {
    try {
      const issues = JSON.parse(detail) as { message?: unknown; path?: unknown }[];
      const issue = issues.find((item) => typeof item?.message === 'string');
      if (issue) {
        const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
        return `${path ? `${path}: ` : ''}${String(issue.message)}`;
      }
    } catch {
      return 'The tool arguments were incomplete. Forge will retry with the required fields.';
    }
  }
  return detail.length <= 220 ? detail : `${detail.slice(0, 217)}…`;
}

export function presentToolResult(message: Message): Presentation {
  const name = message.name ?? 'tool';
  const value = parse(message.content);
  const error = message.content.startsWith('Tool error:');
  if (!value)
    return {
      title: error ? `${label(name)} failed` : label(name),
      summary: error ? conciseToolError(message.content) : message.content.slice(0, 180),
      tone: error ? 'danger' : 'neutral',
      icon: error ? <XCircle size={15} /> : <Activity size={15} />,
      metrics: [],
      paths: [],
      urls: [],
      log: !error && message.content.length > 180 ? message.content : undefined,
      failures: [],
      liveBrowser: false,
    };

  const paths = pathsFrom(value);
  const urls = asStrings(value.urls);
  const failures = [
    ...asStrings(value.failedRequests),
    ...asStrings(value.consoleErrors),
    ...asStrings(value.errors),
    ...asStrings(value.warnings),
  ];
  const output = asText(value.output);
  const status = asText(value.status);
  const base = {
    tone: statusTone(status),
    metrics: [] as string[],
    paths,
    urls,
    failures,
    log: output,
    screenshot: asText(value.screenshot),
    liveBrowser: name.startsWith('browser_'),
  };

  if (name === 'plan_task') {
    const skipped = status === 'skipped';
    return {
      ...base,
      title: skipped ? 'Planning skipped' : 'Task planned',
      summary: asText(value.goal) ?? asText(value.reason),
      tone: skipped ? 'warning' : 'success',
      icon: skipped ? <CircleDashed size={15} /> : <Sparkles size={15} />,
      metrics: [
        count(value.criteria) !== undefined ? `${count(value.criteria)} criteria` : '',
        count(value.requiredChecks) !== undefined ? `${count(value.requiredChecks)} checks` : '',
      ].filter(Boolean),
    };
  }
  if (['read_file', 'read_files'].includes(name))
    return {
      ...base,
      title: name === 'read_file' ? 'File read' : 'Files read',
      summary: paths[0],
      tone: 'success',
      icon: name === 'read_file' ? <FileCode2 size={15} /> : <Files size={15} />,
      metrics: [
        asText(value.totalLines) ? `${asText(value.totalLines)} lines` : '',
        asText(value.totalCharacters) ? `${asText(value.totalCharacters)} characters` : '',
        paths.length > 1 ? `${paths.length} files` : '',
      ].filter(Boolean),
    };
  if (['list_files', 'search_code', 'find_symbol', 'typescript_query'].includes(name))
    return {
      ...base,
      title: name === 'list_files' ? 'Project files indexed' : 'Code searched',
      summary: asText(value.query) ?? asText(value.symbol),
      tone: 'success',
      icon: <Search size={15} />,
      metrics: [
        asText(value.total) ? `${asText(value.total)} results` : '',
        count(value.matches) !== undefined ? `${count(value.matches)} matches` : '',
        count(value.entries) !== undefined ? `${count(value.entries)} files` : '',
      ].filter(Boolean),
    };
  if (['write_file', 'replace_text', 'apply_changeset', 'create_r3f_game'].includes(name))
    return {
      ...base,
      title: value.applied === false ? 'Change was not applied' : 'Workspace updated',
      summary: asText(value.rationale) ?? paths.slice(0, 3).join(', '),
      tone: value.applied === false ? 'warning' : 'success',
      icon: <Pencil size={15} />,
      metrics: [paths.length ? `${paths.length} file${paths.length === 1 ? '' : 's'}` : ''].filter(
        Boolean,
      ),
    };
  if (name === 'run_validation' || name === 'typecheck' || name === 'run_ui_scenario') {
    const passed = value.passed === true || value.success === true || status === 'passed';
    const failed = value.passed === false || value.success === false || status === 'failed';
    return {
      ...base,
      title: passed ? 'Check passed' : failed ? 'Check failed' : 'Check finished',
      summary: asText(value.recipe) ?? (name === 'typecheck' ? 'TypeScript' : undefined),
      tone: passed ? 'success' : failed ? 'danger' : base.tone,
      icon: passed ? (
        <CheckCircle2 size={15} />
      ) : failed ? (
        <XCircle size={15} />
      ) : (
        <Activity size={15} />
      ),
      metrics: [
        asText(value.durationMs) ? `${asText(value.durationMs)} ms` : '',
        value.exitCode !== undefined && value.exitCode !== null
          ? `Exit ${asText(value.exitCode)}`
          : '',
      ].filter(Boolean),
    };
  }
  if (
    [
      'project_mental_model',
      'typescript_project_analysis',
      'inspect_feature',
      'inspect_scene',
      'inspect_native_project',
      'product_architecture',
      'api_contracts',
      'analyze_impact',
      'discover_validation_plan',
      'maintenance_audit',
      'release_readiness',
      'dependency_audit',
      'dependency_outdated',
    ].includes(name)
  )
    return {
      ...base,
      title: name === 'inspect_scene' ? '3D scene inspected' : 'Project analyzed',
      summary: asText(value.query),
      tone: 'success',
      icon: <Sparkles size={15} />,
      metrics: [
        asText(value.total) ? `${asText(value.total)} findings` : '',
        count(value.evidence) !== undefined ? `${count(value.evidence)} findings` : '',
        count(value.frameworks) !== undefined ? `${count(value.frameworks)} frameworks` : '',
      ].filter(Boolean),
    };
  if (['search_local_knowledge', 'web_search', 'contribution_guide'].includes(name))
    return {
      ...base,
      title: name === 'web_search' ? 'Web research complete' : 'Project guidance found',
      summary: asText(value.query),
      tone: 'success',
      icon: <Search size={15} />,
      metrics: [
        count(value.results) !== undefined ? `${count(value.results)} results` : '',
        count(value.files) !== undefined ? `${count(value.files)} files` : '',
      ].filter(Boolean),
    };
  if (name.startsWith('browser_'))
    return {
      ...base,
      title: name === 'browser_screenshot' ? 'Preview captured' : 'Browser inspected',
      summary: urls[0] ?? asText(value.title),
      icon: <Camera size={15} />,
      metrics: [status ?? '', failures.length ? `${failures.length} issues` : ''].filter(Boolean),
    };
  if (
    [
      'start_package_process',
      'list_package_processes',
      'stop_package_process',
      'start_local_preview',
      'inspect_local_preview',
      'check_local_http',
    ].includes(name)
  )
    return {
      ...base,
      title:
        value.running === true
          ? 'Development server running'
          : value.running === false
            ? 'Development server stopped'
            : 'Local process inspected',
      summary: urls[0] ?? asText(value.command),
      tone: value.running === false ? 'warning' : base.tone,
      icon: <Server size={15} />,
      metrics: [
        value.running !== undefined ? (value.running ? 'Running' : 'Stopped') : '',
        asText(value.pid) ? `PID ${asText(value.pid)}` : '',
        value.exitCode !== undefined && value.exitCode !== null
          ? `Exit ${asText(value.exitCode)}`
          : '',
      ].filter(Boolean),
    };
  if (name === 'package_scripts')
    return {
      ...base,
      title: 'Project scripts found',
      summary: asText(value.name),
      tone: 'success',
      icon: <PackageCheck size={15} />,
      metrics: [
        value.scripts && typeof value.scripts === 'object'
          ? `${Object.keys(value.scripts).length} scripts`
          : '',
      ].filter(Boolean),
    };
  if (
    name.includes('package') ||
    name.startsWith('scaffold_') ||
    name === 'install_pnpm_dependencies'
  )
    return {
      ...base,
      title: name.startsWith('scaffold_') ? 'Project created' : 'Packages updated',
      summary: asText(value.name) ?? asStrings(value.packages).join(', '),
      icon: <PackageCheck size={15} />,
      metrics: [status ?? ''].filter(Boolean),
    };
  if (name === 'ask_user_question')
    return {
      ...base,
      title: 'Answer received',
      summary: asText(value.answer),
      tone: 'success',
      icon: <CheckCircle2 size={15} />,
      metrics: [],
    };
  if (name === 'enable_tool_group' || name === 'skill_instructions')
    return {
      ...base,
      title: name === 'enable_tool_group' ? 'Capabilities updated' : 'Skill loaded',
      summary: asText(value.reason) ?? asText(value.skill),
      tone: 'success',
      icon: <Sparkles size={15} />,
      metrics: [],
    };
  if (name.startsWith('git_'))
    return { ...base, title: label(name), icon: <GitBranch size={15} />, summary: status };
  if (name.startsWith('ssh_') || name.startsWith('mcp_'))
    return { ...base, title: label(name), icon: <Server size={15} />, summary: status };
  if (
    name.startsWith('database_') ||
    name.includes('migration') ||
    name.includes('disposable_') ||
    name === 'run_seed_workflow'
  )
    return { ...base, title: label(name), icon: <Database size={15} />, summary: status };

  const safeMetrics = Object.entries(value)
    .filter(
      ([key, item]) =>
        !/^(?:id|runId|fingerprint|hash|digest|content|output)$/i.test(key) &&
        ['string', 'number', 'boolean'].includes(typeof item),
    )
    .slice(0, 3)
    .map(([key, item]) => `${label(key)}: ${String(item).slice(0, 80)}`);
  return {
    ...base,
    title: label(name),
    summary: status,
    icon: failures.length ? <AlertTriangle size={15} /> : <Activity size={15} />,
    metrics: safeMetrics,
  };
}

export function ToolResult({
  message,
  onRead,
}: {
  message: Message;
  onRead?: (path: string) => void;
}) {
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const view = presentToolResult(message);
  const hasDetails =
    view.metrics.length > 0 ||
    view.paths.length > 0 ||
    view.urls.length > 0 ||
    !!view.log ||
    view.failures.length > 0 ||
    !!view.screenshot ||
    view.liveBrowser;
  const summary = (
    <>
      <span className="tool-result-icon">{view.icon}</span>
      <span className="tool-result-copy">
        <strong>{view.title}</strong>
        {view.summary && <span>{view.summary}</span>}
      </span>
      <span className={`tool-result-state tool-result-state-${view.tone}`}>
        {view.tone === 'success' ? 'Done' : view.tone === 'danger' ? 'Failed' : ''}
      </span>
      {hasDetails && <ChevronDown className="tool-result-chevron" size={13} />}
    </>
  );
  if (!hasDetails) return <div className={`tool-result tool-result-${view.tone}`}>{summary}</div>;
  return (
    <details
      className={`tool-result tool-result-${view.tone}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {expanded && (
        <div className="tool-result-body">
          {!!view.metrics.length && (
            <div className="tool-result-metrics">
              {view.metrics.map((metric) => (
                <span key={metric}>{metric}</span>
              ))}
            </div>
          )}
          {!!view.paths.length && (
            <div className="tool-result-paths">
              {view.paths.slice(0, 8).map((file) => (
                <button key={file} onClick={() => onRead?.(file)}>
                  {file}
                </button>
              ))}
            </div>
          )}
          {view.urls.map((url) => (
            <code key={url}>{url}</code>
          ))}
          {!!view.failures.length && (
            <div className="tool-result-errors">{unique(view.failures).slice(0, 6).join('\n')}</div>
          )}
          {view.log && (
            <details className="tool-result-log">
              <summary>Log</summary>
              <pre>{view.log}</pre>
            </details>
          )}
          {view.screenshot && (
            <button
              className="button"
              onClick={() => {
                if (image) return setImage('');
                void api
                  .previewImage(view.screenshot!)
                  .then(setImage)
                  .catch((cause) => setError(cause.message));
              }}
            >
              {image ? 'Hide preview' : 'View preview'}
            </button>
          )}
          {view.liveBrowser && (
            <button
              className="button"
              onClick={() => void api.showBrowser().catch((cause) => setError(cause.message))}
            >
              Show browser
            </button>
          )}
          {image && <img className="artifact-image" src={image} alt="Captured local preview" />}
          {error && <span role="alert">{error}</span>}
        </div>
      )}
    </details>
  );
}
