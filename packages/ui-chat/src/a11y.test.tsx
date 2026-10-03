// A11y markup assertions for the chat webview.
//
// No jsdom in devDependencies (and no new test deps allowed), so these tests
// render components with react-dom/server and assert on the static markup:
// ARIA roles, labels, and state attributes must be present in the HTML the
// webview actually serves. Keyboard behavior of the mention popup lives in
// mentionQuery.ts and is covered by mentionQuery.test.ts.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageList } from './MessageList.js';
import { Composer } from './Composer.js';
import { MentionPopup } from './MentionPopup.js';
import { ModelPill } from './ModelPill.js';
import { StopButton } from './StopButton.js';
import type { ChatMessageView } from './chatClient.js';
import type { MentionItem } from './mentionQuery.js';

const assistantMsg = (over: Partial<ChatMessageView> = {}): ChatMessageView => ({
  id: 'm1',
  role: 'assistant',
  text: 'hello',
  status: 'done',
  toolCalls: [],
  ...over,
});

describe('MessageList a11y', () => {
  it('exposes the message region as a labelled live log', () => {
    const html = renderToStaticMarkup(<MessageList messages={[assistantMsg()]} />);
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-label="Sunday chat messages"');
    expect(html).toContain('aria-live="polite"');
  });

  it('announces the streaming indicator to screen readers', () => {
    const html = renderToStaticMarkup(<MessageList messages={[assistantMsg({ status: 'streaming' })]} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Streaming');
  });

  it('exposes the relay reason as an accessible label (title is mouse-only)', () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[
          assistantMsg({
            via: 'relay',
            relay: { from: 'openrouter', to: 'groq', reason: 'failover' },
          }),
        ]}
      />,
    );
    expect(html).toContain('aria-label="Relayed openrouter → groq: failover"');
  });
});

describe('Composer a11y', () => {
  it('labels the chat input and wires the (closed) mention popup as a combobox', () => {
    const html = renderToStaticMarkup(<Composer onSend={() => undefined} disabled={false} />);
    expect(html).toContain('aria-label="Chat input"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    // No dangling aria-controls when the popup is closed.
    expect(html).not.toContain('aria-controls');
  });

  it('labels the send button (its visual content is a bare arrow)', () => {
    const html = renderToStaticMarkup(<Composer onSend={() => undefined} disabled={false} />);
    expect(html).toContain('aria-label="Send"');
  });
});

describe('MentionPopup a11y', () => {
  const items: MentionItem[] = [
    { kind: 'file', label: '@file', hint: '<path…>', insert: '@file ', description: 'a file' },
    { kind: 'folder', label: '@folder', hint: '<dir…>', insert: '@folder ', description: 'a folder' },
  ];

  it('renders a labelled listbox with addressable options', () => {
    const html = renderToStaticMarkup(<MentionPopup items={items} selected={1} onPick={() => undefined} />);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-label="Mention suggestions"');
    expect(html).toContain('id="mention-opt-0"');
    expect(html).toContain('id="mention-opt-1"');
    // Selected option is marked for aria-activedescendant consumers.
    expect(html).toContain('aria-selected="true"');
  });
});

describe('ModelPill a11y', () => {
  it('labels the model picker', () => {
    const html = renderToStaticMarkup(
      <ModelPill models={[{ id: 'm', label: 'M', provider: 'p' }]} selected="m" onSelect={() => undefined} />,
    );
    expect(html).toContain('aria-label="Model"');
  });
});

describe('StopButton a11y', () => {
  it('labels the stop control (visual content is a bare glyph)', () => {
    const html = renderToStaticMarkup(<StopButton visible onStop={() => undefined} />);
    expect(html).toContain('aria-label="Stop the active turn"');
  });
});
