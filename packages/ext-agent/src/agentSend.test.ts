// Tests for AgentSender: send (direct chatSend + chat focus) and
// sendAndCollect (event subscription before chatSend, delta accumulation).
// `vscode` is mocked; the bridge is a manual mock. No DOM, no network.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('vscode', () => ({
  commands: { executeCommand: mocks.executeCommand },
}));

import { AgentSender } from './agentSend.js';
import type { HostBridge } from './hostBridge.js';

type MockBridge = ReturnType<typeof makeBridge>;
const asBridge = (b: MockBridge): HostBridge => b as unknown as HostBridge;

function makeBridge() {
  const listeners = new Set<(n: unknown) => void>();
  return {
    listeners,
    sessionCreate: vi.fn(async (_p: unknown) => ({ session: { id: 'sess-1' } })),
    chatSend: vi.fn(async (_p: unknown) => ({ turnId: 'turn-1' })),
    onChatEvent: vi.fn((l: (n: unknown) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
  };
}

function makeSender(bridge: MockBridge): AgentSender {
  return new AgentSender({
    ensureBridge: async () => asBridge(bridge),
    getCwd: () => '/ws',
    log: () => undefined,
  });
}

function fire(bridge: MockBridge, notif: unknown): void {
  for (const l of [...bridge.listeners]) l(notif);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentSender.send', () => {
  it('sends via chat/send on a fresh session and focuses the chat view', async () => {
    const bridge = makeBridge();
    const sender = makeSender(bridge);
    const turnId = await sender.send('hello');
    expect(turnId).toBe('turn-1');
    expect(bridge.sessionCreate).toHaveBeenCalledWith({ cwd: '/ws' });
    expect(bridge.chatSend).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      message: 'hello',
      model: undefined,
    });
    expect(mocks.executeCommand).toHaveBeenCalledWith('sunday.chat.focus');
  });

  it('reuses the session across sends', async () => {
    const bridge = makeBridge();
    const sender = makeSender(bridge);
    await sender.send('a');
    await sender.send('b');
    expect(bridge.sessionCreate).toHaveBeenCalledTimes(1);
    expect(bridge.chatSend).toHaveBeenCalledTimes(2);
  });

  it('passes a model override through to chat/send', async () => {
    const bridge = makeBridge();
    await makeSender(bridge).send('hi', 'groq:llama-3.1-8b-instant');
    expect(bridge.chatSend).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      message: 'hi',
      model: 'groq:llama-3.1-8b-instant',
    });
  });
});

describe('AgentSender.sendAndCollect', () => {
  function streamingBridge(deltas: string[], finish: 'stop' | 'error'): MockBridge {
    const bridge = makeBridge();
    bridge.chatSend = vi.fn(async () => {
      setTimeout(() => {
        for (const d of deltas)
          fire(bridge, { turnId: 'turn-1', sessionId: 'sess-1', event: { type: 'text-delta', delta: d } });
        fire(
          bridge,
          finish === 'stop'
            ? { turnId: 'turn-1', sessionId: 'sess-1', event: { type: 'turn-end', finishReason: 'stop' } }
            : { turnId: 'turn-1', sessionId: 'sess-1', event: { type: 'turn-error', code: 500, message: 'boom' } },
        );
      }, 0);
      return { turnId: 'turn-1' };
    });
    return bridge;
  }

  it('collects text deltas until turn-end', async () => {
    const bridge = streamingBridge(['feat: ', 'add thing'], 'stop');
    const res = await makeSender(bridge).sendAndCollect('prompt', 'm');
    expect(res).toEqual({ ok: true, text: 'feat: add thing' });
    expect(bridge.onChatEvent).toHaveBeenCalledTimes(1);
  });

  it('ignores events belonging to other turns', async () => {
    const bridge = streamingBridge(['mine'], 'stop');
    bridge.chatSend = vi.fn(async () => {
      setTimeout(() => {
        fire(bridge, { turnId: 'other', sessionId: 'sess-1', event: { type: 'text-delta', delta: 'NOPE' } });
        fire(bridge, { turnId: 'turn-1', sessionId: 'sess-1', event: { type: 'text-delta', delta: 'mine' } });
        fire(bridge, { turnId: 'turn-1', sessionId: 'sess-1', event: { type: 'turn-end', finishReason: 'stop' } });
      }, 0);
      return { turnId: 'turn-1' };
    });
    const res = await makeSender(bridge).sendAndCollect('prompt', 'm');
    expect(res).toEqual({ ok: true, text: 'mine' });
  });

  it('reports turn-error', async () => {
    const bridge = streamingBridge([], 'error');
    const res = await makeSender(bridge).sendAndCollect('prompt', 'm');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('boom');
  });

  it('times out when the turn never ends', async () => {
    const bridge = makeBridge();
    const res = await makeSender(bridge).sendAndCollect('prompt', 'm', 20);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/);
  });
});
