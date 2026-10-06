import { memo, useState } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import { Terminal, ChevronDown, BookmarkPlus, Activity, Camera, PackageCheck } from 'lucide-react';
import type { Message } from '../../shared/types';
import { Mark } from './ui';
import { api } from '../api';
const markdownComponents: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: () => null,
};
const artifactTools = new Set([
  'start_package_process',
  'list_package_processes',
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_press',
  'browser_screenshot',
  'package_dependencies',
  'run_validation',
  'run_ui_scenario',
  'check_local_http',
  'browser_wait',
  'browser_assert',
  'browser_select',
  'browser_scroll',
  'browser_viewport',
  'database_migrate',
  'run_seed_workflow',
  'scaffold_product',
  'maintenance_audit',
  'dependency_audit',
  'dependency_outdated',
  'release_readiness',
  'mcp_connect',
  'mcp_call',
]);

function ToolArtifact({ message, onRead }: { message: Message; onRead?: (path: string) => void }) {
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  let value: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(message.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!artifactTools.has(message.name ?? '')) return null;
  const urls = Array.isArray(value.urls) ? value.urls.map(String) : [];
  const failures = [
    ...(Array.isArray(value.failedRequests) ? value.failedRequests : []),
    ...(Array.isArray(value.consoleErrors) ? value.consoleErrors : []),
    ...(Array.isArray(value.console)
      ? value.console.filter((line) => typeof line === 'string' && line.startsWith('error:'))
      : []),
  ].map(String);
  const references =
    typeof value.output === 'string'
      ? [...value.output.matchAll(/(?:^|\s)([\w./-]+\.[cm]?[jt]sx?)(?::\d+|\(\d+,\d+\))/gm)]
          .map((match) => match[1])
          .filter((file) => !file.startsWith('/') && !file.split('/').includes('..'))
          .slice(0, 8)
      : [];
  const icon = message.name?.startsWith('browser_') ? (
    <Camera size={15} />
  ) : message.name === 'package_dependencies' ? (
    <PackageCheck size={15} />
  ) : (
    <Activity size={15} />
  );
  return (
    <div className="tool-artifact">
      <div>
        {icon}
        <strong>{message.name?.replaceAll('_', ' ')}</strong>
      </div>
      {'running' in value && (
        <span className="artifact-metric">{value.running ? 'Running' : 'Stopped'}</span>
      )}
      {'exitCode' in value && value.exitCode !== null && (
        <span className="artifact-metric">Exit {String(value.exitCode)}</span>
      )}
      {'status' in value && <span className="artifact-metric">{String(value.status)}</span>}
      {'passed' in value && (
        <span className="artifact-metric">{value.passed ? 'Passed' : 'Failed'}</span>
      )}
      {'screenshot' in value && (
        <>
          <button
            className="button"
            onClick={() => {
              if (image) {
                setImage('');
                return;
              }
              void api
                .previewImage(String(value.screenshot))
                .then(setImage)
                .catch((error) => setError(error.message));
            }}
          >
            {image ? 'Hide screenshot' : 'View screenshot'}
          </button>
          {image && <img className="artifact-image" src={image} alt="Captured local preview" />}
        </>
      )}
      {message.name?.startsWith('browser_') && (
        <button
          className="button"
          onClick={() => void api.showBrowser().catch((error) => setError(error.message))}
        >
          Show live browser
        </button>
      )}
      {!!failures.length && (
        <details>
          <summary>Browser errors ({failures.length})</summary>
          <pre>{failures.join('\n')}</pre>
        </details>
      )}
      {[...new Set(references)].map((file) => (
        <button key={file} className="button" onClick={() => onRead?.(file)}>
          Open {file}
        </button>
      ))}
      {error && <span role="alert">{error}</span>}
      {'packages' in value && Array.isArray(value.packages) && (
        <span>{value.packages.map(String).join(', ')}</span>
      )}
      {urls.map((url) => (
        <code key={url}>{url}</code>
      ))}
    </div>
  );
}
const MessageRow = memo(function MessageRow({
  message,
  onCapture,
  onRead,
}: {
  message: Message;
  onCapture: (id: string) => void;
  onRead?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (message.role === 'tool') {
    const artifact = <ToolArtifact message={message} onRead={onRead} />;
    return (
      <>
        {artifact}
        <details className="tool-message" onToggle={(e) => setExpanded(e.currentTarget.open)}>
          <summary>
            <Terminal size={14} />
            {message.name}
            <span>Tool output</span>
            <ChevronDown size={13} />
          </summary>
          {expanded && <pre>{message.content}</pre>}
        </details>
      </>
    );
  }
  return (
    <article className={`message ${message.role}`}>
      <div className="message-avatar">{message.role === 'assistant' ? <Mark small /> : 'Y'}</div>
      <div className="message-body">
        <div className="message-heading">
          <strong>{message.role === 'assistant' ? 'Forge' : 'You'}</strong>
          <span>
            {new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {message.role === 'assistant' && (
            <button
              title="Save as training example"
              className="icon-button"
              onClick={() => onCapture(message.id)}
            >
              <BookmarkPlus size={14} />
            </button>
          )}
        </div>
        <div className="markdown">
          <ReactMarkdown components={markdownComponents}>{message.content}</ReactMarkdown>
        </div>
      </div>
    </article>
  );
});
export const MessageHistory = memo(function MessageHistory({
  messages,
  onCapture,
  onRead,
}: {
  messages: Message[];
  onCapture: (id: string) => void;
  onRead?: (path: string) => void;
}) {
  const visible = messages.filter((message) => message.role !== 'assistant' || message.content);
  const [start, setStart] = useState(() => Math.max(0, visible.length - 60));
  return (
    <>
      {start > 0 && (
        <button className="button" onClick={() => setStart((index) => Math.max(0, index - 60))}>
          Show older messages ({start})
        </button>
      )}
      {visible.slice(start).map((message) => (
        <MessageRow key={message.id} message={message} onCapture={onCapture} onRead={onRead} />
      ))}
    </>
  );
});
