/**
 * agentBackend stale-session regression tests (audit M7).
 *
 * ideSessionId is cached for the life of the IDE, but the daemon can be
 * respawned underneath it (crash → circuit-breaker recovery). The
 * cached id then belongs to a dead daemon instance and every chat/send
 * failed with SessionNotFound until the IDE restarted. realAgentSend
 * must drop the cached id on that specific error and retry ONCE with a
 * fresh session — and must not retry anything else.
 *
 * daemonClient is mocked; everything else in agentBackend (budget
 * gate, estimator, ledger, trace) is the real code.
 */
import { describe, expect, it, vi } from 'vitest';

type ChatHandler = (ev: { type: string; [k: string]: unknown }) => void;
type RpcImpl = (method: string, params: unknown) => Promise<unknown>;

vi.mock('./daemonClient.js', () => ({
  daemonRpc: vi.fn(),
  addChatEventHandler: vi.fn(),
  removeChatEventHandler: vi.fn(),
}));

interface Harness {
  backend: typeof import('./agentBackend.js');
  emit(ev: { type: string; [k: string]: unknown }): void;
  handlerCount(): number;
}

async function loadBackend(rpcImpl: RpcImpl): Promise<Harness> {
  vi.resetModules();
  const dc = await import('./daemonClient.js');
  const handlers = new Set<ChatHandler>();
  const rpcMock = dc.daemonRpc as unknown as {
    mockImplementation: (fn: RpcImpl) => void;
  };
  rpcMock.mockImplementation(rpcImpl);
  const addMock = dc.addChatEventHandler as unknown as {
    mockImplementation: (fn: (h: ChatHandler) => void) => void;
  };
  addMock.mockImplementation((h) => {
    handlers.add(h);
  });
  const removeMock = dc.removeChatEventHandler as unknown as {
    mockImplementation: (fn: (h: ChatHandler) => void) => void;
  };
  removeMock.mockImplementation((h) => {
    handlers.delete(h);
  });
  const backend = await import('./agentBackend.js');
  return {
    backend,
    emit: (ev) => {
      for (const h of [...handlers]) h(ev);
    },
    handlerCount: () => handlers.size,
  };
}

async function waitForHandler(h: Harness): Promise<void> {
  for (let i = 0; i < 200 && h.handlerCount() === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (h.handlerCount() === 0) throw new Error('agent event handler never registered');
}

describe('agentBackend stale daemon session (audit M7)', () => {
  it('retries once with a fresh session when chat/send reports SessionNotFound', async () => {
    let creates = 0;
    let turns = 0;
    let stale = false;
    const sends: string[] = [];
    const h = await loadBackend(async (method, params) => {
      if (method === 'session/create') return { id: `sess-${++creates}` };
      if (method === 'chat/send') {
        const sid = (params as { sessionId: string }).sessionId;
        sends.push(sid);
        if (stale && sid === 'sess-1') throw new Error('session not found: sess-1');
        return { turnId: `turn-${++turns}` };
      }
      throw new Error(`unexpected RPC ${method}`);
    });

    // First send establishes sess-1 and completes a turn.
    const p1 = h.backend.realAgentSend({ message: 'hello', mode: 'agent', model: 'auto' });
    await waitForHandler(h);
    h.emit({ type: 'text-delta', turnId: 'turn-1', delta: 'hi' });
    h.emit({ type: 'turn-end', turnId: 'turn-1' });
    const r1 = await p1;
    expect(r1.sessionId).toBe('sess-1');
    expect(r1.content).toBe('hi');

    // The daemon "restarted": sess-1 is now unknown to it.
    stale = true;
    const p2 = h.backend.realAgentSend({ message: 'again', mode: 'agent', model: 'auto' });
    await waitForHandler(h);
    h.emit({ type: 'turn-end', turnId: 'turn-2' });
    const r2 = await p2;

    // Self-healed: a fresh session was created and the reply carries it.
    expect(r2.sessionId).toBe('sess-2');
    expect(creates).toBe(2);
    expect(sends).toEqual(['sess-1', 'sess-1', 'sess-2']);
  });

  it('does not retry chat/send for non-session errors', async () => {
    let creates = 0;
    let sendAttempts = 0;
    const h = await loadBackend(async (method) => {
      if (method === 'session/create') return { id: `sess-${++creates}` };
      if (method === 'chat/send') {
        sendAttempts++;
        throw new Error('provider unavailable');
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    await expect(
      h.backend.realAgentSend({ message: 'x', mode: 'agent', model: 'auto' }),
    ).rejects.toThrow('provider unavailable');
    expect(sendAttempts).toBe(1);
    expect(creates).toBe(1);
  });

  it('a second SessionNotFound after the retry propagates (no retry loop)', async () => {
    let creates = 0;
    let sendAttempts = 0;
    const h = await loadBackend(async (method) => {
      if (method === 'session/create') return { id: `sess-${++creates}` };
      if (method === 'chat/send') {
        sendAttempts++;
        throw new Error('session not found: whatever');
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    await expect(
      h.backend.realAgentSend({ message: 'x', mode: 'agent', model: 'auto' }),
    ).rejects.toThrow('session not found');
    expect(sendAttempts).toBe(2); // original + exactly one retry
    expect(creates).toBe(2);
  });
});
