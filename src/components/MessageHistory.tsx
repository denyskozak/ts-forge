import { memo, useState } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import { Terminal, ChevronDown, BookmarkPlus, Activity, Camera, PackageCheck } from 'lucide-react';
import type { Message } from '../../shared/types';
import { Mark } from './ui';
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
]);

function ToolArtifact({ message }: { message: Message }) {
  let value: Record<string, unknown> | undefined;
  try {
    value = JSON.parse(message.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!artifactTools.has(message.name ?? '')) return null;
  const urls = Array.isArray(value.urls) ? value.urls.map(String) : [];
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
      {'screenshot' in value && <code>{String(value.screenshot)}</code>}
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
}: {
  message: Message;
  onCapture: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (message.role === 'tool') {
    const artifact = <ToolArtifact message={message} />;
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
}: {
  messages: Message[];
  onCapture: (id: string) => void;
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
        <MessageRow key={message.id} message={message} onCapture={onCapture} />
      ))}
    </>
  );
});
