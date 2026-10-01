// RpcClient tests — real child processes running the fixture daemon
// (no mocks of the transport itself). No network, no API keys.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { RpcClient, RpcError, RpcTimeoutError, RpcClosedError } from './rpc.js';

const FIXTURE = fileURLToPath(new URL('./test/fixtures/mini-sundayd.mjs', import.meta.url));

const procs: ChildProcess[] = [];
function spawnFixture(args: string[] = []): ChildProcess {
  const p = spawn(process.execPath, [FIXTURE, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  procs.push(p);
  return p;
}

afterEach(() => {
  for (const p of procs.splice(0)) {
    try {
      if (p.exitCode === null) p.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
});

describe('RpcClient', () => {
  it('correlates concurrent requests with their responses', async () => {
    const client = new RpcClient(spawnFixture());
    const [a, b, c] = await Promise.all([
      client.request('sunday/ping', {}),
      client.request('session/list', {}),
      client.request('sunday/ping', {}),
    ]);
    expect((a as { ok: boolean }).ok).toBe(true);
    expect((b as { sessions: unknown[] }).sessions).toEqual([]);
    expect((c as { ok: boolean }).ok).toBe(true);
    client.close();
  });

  it('dispatches notifications to all subscribers and honours unsubscribe', async () => {
    const client = new RpcClient(spawnFixture());
    const seen1: unknown[] = [];
    const seen2: unknown[] = [];
    const off = client.onNotification('chat/event', (p) => seen1.push(p));
    client.onNotification('chat/event', (p) => seen2.push(p));
    await client.request('chat/send', { sessionId: 's', message: 'hi' });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen1.length).toBe(2); // text-delta + turn-end
    expect(seen2.length).toBe(2);
    off();
    await client.request('chat/send', { sessionId: 's', message: 'hi' });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen1.length).toBe(2);
    expect(seen2.length).toBe(4);
    client.close();
  });

  it('rejects with RpcError on server error responses', async () => {
    const client = new RpcClient(spawnFixture());
    const err = await client.request('nope/not-a-method', {}).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32601);
    client.close();
  });

  it('rejects with RpcTimeoutError when the daemon stays silent', async () => {
    const client = new RpcClient(spawnFixture(['--silent']));
    const err = await client.request('sunday/ping', {}, { timeoutMs: 150 }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcTimeoutError);
    expect((err as RpcTimeoutError).method).toBe('sunday/ping');
    client.close();
  });

  it('rejects in-flight requests with RpcClosedError on close()', async () => {
    const client = new RpcClient(spawnFixture(['--silent']));
    const pending = client.request('sunday/ping', {}, { timeoutMs: 10000 });
    client.close();
    await expect(pending).rejects.toBeInstanceOf(RpcClosedError);
  });

  it('rejects new requests after close()', async () => {
    const client = new RpcClient(spawnFixture());
    client.close();
    await expect(client.request('sunday/ping', {})).rejects.toBeInstanceOf(RpcClosedError);
  });

  it('reports malformed stdout lines and keeps the transport alive', async () => {
    const client = new RpcClient(spawnFixture(['--greet-garbage']));
    const bad: string[] = [];
    client.onMalformedLine = (line) => bad.push(line);
    const res = (await client.request('sunday/ping', {})) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(bad).toEqual(['this is not json-rpc']);
    client.close();
  });

  it('ignores server->client requests without breaking', async () => {
    const client = new RpcClient(spawnFixture());
    // No such traffic exists in Phase 1; just ensure a normal round-trip works
    // and the client does not throw on unexpected frames.
    const res = (await client.request('tools/list', {})) as { tools: unknown[] };
    expect(res.tools).toEqual([]);
    client.close();
  });

  it('forwards stderr lines to onStderrLine', async () => {
    const client = new RpcClient(spawnFixture(['--stderr-greet', 'diag one']));
    const lines: string[] = [];
    client.onStderrLine = (l) => lines.push(l);
    await new Promise((r) => setTimeout(r, 200));
    expect(lines).toEqual(['diag one']);
    client.close();
  });
});
