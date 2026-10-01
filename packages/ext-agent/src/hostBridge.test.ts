// HostBridge tests — typed facade over a real fixture daemon.
// No network, no API keys, no vscode API.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { RpcClient } from './rpc.js';
import { HostBridge } from './hostBridge.js';
import type { ChatEventNotification } from '@sunday/protocol';

const FIXTURE = fileURLToPath(new URL('./test/fixtures/mini-sundayd.mjs', import.meta.url));

const procs: ChildProcess[] = [];
async function makeBridge(args: string[] = []): Promise<{ bridge: HostBridge; client: RpcClient }> {
  const proc = spawn(process.execPath, [FIXTURE, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  procs.push(proc);
  const client = new RpcClient(proc);
  // Wait until the daemon answers — proves the transport is up.
  await client.request('sunday/ping', {}, { timeoutMs: 5000 });
  return { bridge: new HostBridge(client), client };
}

afterEach(async () => {
  for (const p of procs.splice(0)) {
    try {
      if (p.exitCode === null) p.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
});

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('HostBridge', () => {
  it('ping() returns the daemon time', async () => {
    const { bridge, client } = await makeBridge();
    const res = await bridge.ping();
    expect(res.ok).toBe(true);
    expect(typeof res.time).toBe('string');
    bridge.dispose();
    client.close();
  });

  it('sessionCreate() returns a validated session', async () => {
    const { bridge, client } = await makeBridge();
    const { session } = await bridge.sessionCreate({ title: 'hello' });
    expect(session.id).toBe('sess-test-1');
    expect(session.title).toBe('hello');
    const list = await bridge.sessionList();
    expect(list.sessions).toEqual([]);
    await bridge.sessionClose(session.id);
    bridge.dispose();
    client.close();
  });

  it('chatSend() tracks the turn and streams chat/event until turn-end', async () => {
    const { bridge, client } = await makeBridge();
    const events: ChatEventNotification[] = [];
    const off = bridge.onChatEvent((n) => events.push(n));

    const { turnId } = await bridge.chatSend({ sessionId: 'sess-test-1', message: 'hi' });
    expect(turnId).toBe('turn-test-1');
    expect(bridge.getActiveTurnId()).toBe('turn-test-1');

    await waitFor(() => events.some((e) => e.event.type === 'turn-end'));
    expect(events.map((e) => e.event.type)).toEqual(['text-delta', 'turn-end']);
    expect(events[0].event.type === 'text-delta' && events[0].event.delta).toBe('hi');
    // turn-end clears the tracked turn
    expect(bridge.getActiveTurnId()).toBeUndefined();

    off();
    bridge.dispose();
    client.close();
  });

  it('cancelActiveTurn() returns false with no active turn, true otherwise', async () => {
    const { bridge, client } = await makeBridge(['--no-chat-events']);
    expect(await bridge.cancelActiveTurn()).toBe(false);
    await bridge.chatSend({ sessionId: 's', message: 'hi' });
    expect(await bridge.cancelActiveTurn()).toBe(true);
    expect(bridge.getActiveTurnId()).toBeUndefined();
    bridge.dispose();
    client.close();
  });

  it('toolsList() and modelsList() return validated catalogues', async () => {
    const { bridge, client } = await makeBridge();
    expect(await bridge.toolsList()).toEqual({ tools: [] });
    expect(await bridge.modelsList()).toEqual({ models: [] });
    bridge.dispose();
    client.close();
  });

  it('dispose() detaches chat/event listeners', async () => {
    const { bridge, client } = await makeBridge();
    let count = 0;
    bridge.onChatEvent(() => count++);
    bridge.dispose();
    await bridge.chatSend({ sessionId: 's', message: 'hi' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(count).toBe(0);
    client.close();
  });

  it('mcp/* round-trips: servers, lifecycle, tools, call history', async () => {
    const { bridge, client } = await makeBridge();
    const servers = await bridge.mcpServersList();
    expect(servers.servers.map((s) => s.name)).toEqual(['fixture-srv']);
    expect(servers.workspaceConfigIgnored).toBe(false);
    expect(servers.workspaceTrusted).toBe(true);
    expect((await bridge.mcpServerStart('fixture-srv')).status.state).toBe('running');
    expect((await bridge.mcpServerStop('fixture-srv')).status.state).toBe('running');
    expect((await bridge.mcpServerRestart('fixture-srv')).status.state).toBe('running');
    const tools = await bridge.mcpToolsList();
    expect(tools.tools.map((t) => t.namespaced)).toEqual(['mcp__fixture_srv__echo']);
    expect(await bridge.mcpCallsHistory(10)).toEqual({ calls: [] });
    bridge.dispose();
    client.close();
  });

  it('policy/* round-trips: approve, revoke, list', async () => {
    const { bridge, client } = await makeBridge();
    expect(await bridge.policyApprove('mcp__fixture_srv__echo')).toEqual({ ok: true });
    expect(await bridge.policyRevoke('mcp__fixture_srv__echo')).toEqual({ ok: true });
    expect(await bridge.policyList()).toEqual({ dangerous: [], approved: [] });
    bridge.dispose();
    client.close();
  });

  it('completion/* round-trips: ghost text + latency stats', async () => {
    const { bridge, client } = await makeBridge();
    const res = await bridge.completionComplete({
      uri: 'file:///a.ts',
      position: { line: 0, character: 11 },
      prefix: 'const x = 1',
      suffix: '\n',
      docVersion: 3,
      model: 'groq:llama-3.1-8b-instant',
    });
    expect(res).toMatchObject({
      completion: ' + 1;',
      nativeFim: true,
      cancelled: false,
    });
    const stats = await bridge.completionStats();
    expect(stats).toMatchObject({ count: 1, cacheHits: 0, cacheMisses: 1 });
    bridge.dispose();
    client.close();
  });
});
