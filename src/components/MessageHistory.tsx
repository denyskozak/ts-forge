import { memo, useState } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import { BookmarkPlus } from 'lucide-react';
import type { Message } from '../../shared/types';
import { presentAssistantText } from '../message-presentation';
import { Mark } from './ui';
import { ToolResult } from './ToolResult';
const markdownComponents: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: () => null,
};
const MessageRow = memo(function MessageRow({
  message,
  onCapture,
  onRead,
}: {
  message: Message;
  onCapture: (id: string) => void;
  onRead?: (path: string) => void;
}) {
  if (message.role === 'tool') {
    return <ToolResult message={message} onRead={onRead} />;
  }
  const content =
    message.role === 'assistant' ? presentAssistantText(message.content) : message.content;
  if (!content) return null;
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
          <ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
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
  const visible = messages.filter(
    (message) => message.role !== 'assistant' || presentAssistantText(message.content),
  );
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
