// Unit tests for the framework-free chat reducer (chatClient) and the tiny
// markdown renderer. No DOM, no React, no network.
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  applyModelsList,
  applyTurnState,
  createInitialState,
  queueUserMessage,
  selectModel,
  type ChatEventNotificationWire,
} from './chatClient.js';
import { renderMarkdown } from './markdown.js';

function notif(over: Partial<ChatEventNotificationWire> = {}): ChatEventNotificationWire {
  return {
    turnId: 'turn-1',
    sessionId: 'sess-1',
    event: { type: 'text-delta', delta: '' },
    ...over,
  };
}

describe('chatClient reducer', () => {
  it('appends text deltas to a streaming assistant message', () => {
    let s = createInitialState();
    s = applyEvent(s, notif({ event: { type: 'text-delta', delta: 'Hello' } }));
    s = applyEvent(s, notif({ event: { type: 'text-delta', delta: ' world' } }));
    expect(s.messages).toHaveLength(1);
    const m = s.messages[0];
    expect(m.role).toBe('assistant');
    expect(m.text).toBe('Hello world');
    expect(m.status).toBe('streaming');
    expect(s.activeTurnId).toBe('turn-1');
  });

  it('queues the user message optimistically before any delta arrives', () => {
    let s = createInitialState();
    s = queueUserMessage(s, 'hi there');
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[0].text).toBe('hi there');
    s = applyEvent(s, notif({ event: { type: 'text-delta', delta: 'yo' } }));
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].role).toBe('assistant');
  });

  it('attaches tool calls and marks them done on tool-result', () => {
    let s = createInitialState();
    s = applyEvent(
      s,
      notif({ event: { type: 'tool-call', call: { id: 'c1', name: 'fs_read', arguments: { path: 'a.txt' } } } }),
    );
    expect(s.messages[0].toolCalls).toHaveLength(1);
    expect(s.messages[0].toolCalls[0].status).toBe('running');
    expect(s.messages[0].toolCalls[0].name).toBe('fs_read');
    s = applyEvent(s, notif({ event: { type: 'tool-result', result: { id: 'c1', ok: true, summary: '42 bytes' } } }));
    expect(s.messages[0].toolCalls[0].status).toBe('done');
    expect(s.messages[0].toolCalls[0].resultSummary).toBe('42 bytes');
  });

  it('marks the message done and clears the active turn on turn-end', () => {
    let s = createInitialState();
    s = applyEvent(s, notif({ event: { type: 'text-delta', delta: 'x' } }));
    expect(s.activeTurnId).toBe('turn-1');
    s = applyEvent(s, notif({ event: { type: 'turn-end', finishReason: 'stop' } }));
    expect(s.messages[0].status).toBe('done');
    expect(s.activeTurnId).toBeUndefined();
  });

  it('surfaces turn-error on the message and clears the active turn', () => {
    let s = createInitialState();
    s = applyEvent(s, notif({ event: { type: 'text-delta', delta: 'partial' } }));
    s = applyEvent(s, notif({ event: { type: 'turn-error', code: -32000, message: 'provider blew up' } }));
    expect(s.messages[0].status).toBe('error');
    expect(s.messages[0].error).toBe('provider blew up');
    expect(s.activeTurnId).toBeUndefined();
  });

  it('sets the relay flag when via=relay so the UI can badge the turn', () => {
    let s = createInitialState();
    s = applyEvent(
      s,
      notif({
        event: { type: 'text-delta', delta: 'hi' },
        via: 'relay',
        relay: { from: 'openrouter', to: 'groq', reason: '429 rate limited' },
      }),
    );
    const m = s.messages[0];
    expect(m.via).toBe('relay');
    expect(m.relay).toEqual({ from: 'openrouter', to: 'groq', reason: '429 rate limited' });
    // A later direct event must not clobber the relay badge.
    s = applyEvent(s, notif({ event: { type: 'text-delta', delta: '!' }, via: 'direct' }));
    expect(s.messages[0].via).toBe('relay');
  });

  it('attaches usage to the turn message', () => {
    let s = createInitialState();
    s = applyEvent(s, notif({ event: { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } } }));
    expect(s.messages[0].usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('does not mutate the previous state', () => {
    const s0 = createInitialState();
    const s1 = applyEvent(s0, notif({ event: { type: 'text-delta', delta: 'a' } }));
    expect(s0.messages).toHaveLength(0);
    expect(s1.messages).toHaveLength(1);
  });

  it('applyModelsList selects the first model and preserves a valid selection', () => {
    let s = createInitialState();
    s = applyModelsList(s, [
      { id: 'groq:llama', provider: 'groq', label: 'Llama' },
      { id: 'or:m1', provider: 'openrouter', label: 'M1' },
    ]);
    expect(s.selectedModel).toBe('groq:llama');
    s = selectModel(s, 'or:m1');
    expect(s.selectedModel).toBe('or:m1');
    // Unknown id is ignored.
    s = selectModel(s, 'nope');
    expect(s.selectedModel).toBe('or:m1');
    // Refresh that drops the selection falls back to first.
    s = applyModelsList(s, [{ id: 'groq:llama', provider: 'groq', label: 'Llama' }]);
    expect(s.selectedModel).toBe('groq:llama');
  });

  it('applyModelsList/selectModel never select a plan-gated (disabled) model', () => {
    let s = createInitialState();
    s = applyModelsList(s, [
      { id: 'sunday:flash', provider: 'sunday', label: 'Flash', disabled: true, hint: 'Daily limit reached — upgrade' },
      { id: 'groq:llama', provider: 'groq', label: 'Llama' },
    ]);
    // First model is gated → the selectable one is picked instead.
    expect(s.selectedModel).toBe('groq:llama');
    // Programmatic selection of a gated model is ignored.
    s = selectModel(s, 'sunday:flash');
    expect(s.selectedModel).toBe('groq:llama');
    // A refresh that gates the current selection moves it to a live model.
    s = applyModelsList(s, [
      { id: 'sunday:flash', provider: 'sunday', label: 'Flash' },
      { id: 'groq:llama', provider: 'groq', label: 'Llama', disabled: true, hint: 'Daily limit reached — upgrade' },
    ]);
    expect(s.selectedModel).toBe('sunday:flash');
  });

  it('applyTurnState tracks the active turn', () => {
    let s = createInitialState();
    s = applyTurnState(s, 'turn-9');
    expect(s.activeTurnId).toBe('turn-9');
    s = applyTurnState(s, null);
    expect(s.activeTurnId).toBeUndefined();
  });
});

describe('renderMarkdown', () => {
  it('renders paragraphs and bold', () => {
    const html = renderMarkdown('Hello **world**');
    expect(html).toContain('<p>Hello <strong>world</strong></p>');
  });

  it('renders fenced code blocks without processing their content', () => {
    const html = renderMarkdown('```js\nconst a = **not bold**;\n```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('const a = **not bold**;');
    expect(html).not.toContain('<strong>');
  });

  it('renders inline code and leaves ** inside it alone', () => {
    const html = renderMarkdown('run `a **b** c` now');
    expect(html).toContain('<code>a **b** c</code>');
    expect(html).not.toContain('<strong>');
  });

  it('escapes HTML so model output cannot inject markup', () => {
    const html = renderMarkdown('<script>alert(1)</script> **x**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>x</strong>');
  });

  it('splits paragraphs on blank lines and keeps single newlines as breaks', () => {
    const html = renderMarkdown('one\ntwo\n\nthree');
    expect(html).toContain('<p>one<br>two</p>');
    expect(html).toContain('<p>three</p>');
  });
});
