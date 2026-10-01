import { useEffect, useRef } from 'react';
import { renderMarkdown } from './markdown.js';
import type { ChatMessageView } from './chatClient.js';

function relayTitle(msg: ChatMessageView): string {
  const r = msg.relay;
  return r ? `Relayed ${r.from} → ${r.to}: ${r.reason}` : 'Relayed via a fallback provider';
}

function Message({ msg }: { key?: unknown; msg: ChatMessageView }): JSX.Element {
  const cls = msg.role === 'user' ? 'msg msg-user' : 'msg msg-assistant';
  return (
    <div className={cls}>
      <div className="msg-head">
        <span className="msg-role">{msg.role === 'user' ? 'You' : 'Sunday'}</span>
        {msg.via === 'relay' && (
          <span className="relay-badge" aria-label={relayTitle(msg)}>
            ⟳ Relay
          </span>
        )}
        {msg.status === 'streaming' && <span className="streaming-dot" role="img" aria-label="Streaming…" />}
      </div>
      {msg.role === 'assistant' ? (
        <div className="msg-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }} />
      ) : (
        <div className="msg-body msg-user-text">{msg.text}</div>
      )}
      {msg.toolCalls.length > 0 && (
        <div className="tool-calls">
          {msg.toolCalls.map((tc) => (
            <div key={tc.id} className={`tool-call tc-${tc.status}`} title={tc.argsSummary}>
              <span className="tc-icon">{tc.status === 'running' ? '◌' : '✓'}</span>
              <code>{tc.name}</code>
              {tc.resultSummary && <span className="tc-result">{tc.resultSummary}</span>}
            </div>
          ))}
        </div>
      )}
      {msg.error && <div className="msg-error">{msg.error}</div>}
      {msg.usage && (
        <div className="msg-usage">
          {msg.usage.inputTokens} in / {msg.usage.outputTokens} out
        </div>
      )}
    </div>
  );
}

export function MessageList({ messages }: { messages: ChatMessageView[] }): JSX.Element {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);
  return (
    <div className="msg-list" role="log" aria-label="Sunday chat messages" aria-live="polite">
      {messages.length === 0 && (
        <div className="empty">
          <div className="empty-title">Sunday Chat</div>
          <div className="empty-sub">Ask anything — Sunday plans, edits, and runs tools for you.</div>
        </div>
      )}
      {messages.map((m) => (
        <Message key={m.id} msg={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
