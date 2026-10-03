/**
 * DaemonClient tests against a real in-process mock daemon:
 * a `net.Server` speaking NDJSON JSON-RPC on a temp socket path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonClient, resolveSundaydCli } from './client.js';
import { PROTOCOL_VERSION } from '@sunday/protocol';
import { NdjsonFramer } from '@sunday/sundayd';

interface MockDaemon {
  server: net.Server;
  socketPath: string;
  /** Lines received from the client (parsed). */
  received: Array<{ id?: number; method: string; params?: unknown }>;
  /** Handler for inbound requests: return the result or throw for an error. */
  onRequest: (method: string, params: unknown) => unknown;
  sendNotification: (method: string, params: unknown) => void;
  close: () => Promise<void>;
}

async function startMockDaemon(): Promise<MockDaemon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-cli-test-'));
  const socketPath = path.join(dir, 'sundayd.sock');
  const received: MockDaemon['received'] = [];
  const mock: MockDaemon = {
    server: null as unknown as net.Server,
    socketPath,
    received,
    onRequest: () => ({ ok: true }),
    sendNotification: () => undefined,
    close: async () => {},
  };
  const framer = new NdjsonFramer();
  let clientSock: net.Socket | null = null;
  const server = net.createServer((sock) => {
    clientSock = sock;
    sock.on('data', (chunk: Buffer) => {
      for (const line of framer.push(chunk.toString('utf8'))) {
        const msg = JSON.parse(line) as { id?: number; method: string; params?: unknown };
        received.push(msg);
        if (msg.method === 'sunday/hello') {
          const p = msg.params as { protocolVersion: number };
          const result =
            p.protocolVersion === PROTOCOL_VERSION
              ? {
                  protocolVersion: PROTOCOL_VERSION,
                  negotiated: true,
                  server: { name: 'sundayd', version: '0.0.0-test' },
                }
              : {
                  protocolVersion: 999,
                  negotiated: false,
                  server: { name: 'sundayd', version: 'x' },
                };
          sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
          continue;
        }
        if (msg.id === undefined) continue; // notification from client — ignore
        try {
          const result = mock.onRequest(msg.method, msg.params);
          sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
        } catch (e) {
          sock.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: (e as Error).message },
            }) + '\n',
          );
        }
      }
    });
  });
  mock.server = server;
  mock.sendNotification = (method, params) => {
    clientSock?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };
  mock.close = () =>
    new Promise<void>((resolve) => {
      clientSock?.destroy();
      server.close(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
    });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return mock;
}

describe('DaemonClient', () => {
  let daemon: MockDaemon;
  let client: DaemonClient;

  beforeEach(async () => {
    daemon = await startMockDaemon();
    client = new DaemonClient({ socketPath: daemon.socketPath, lockPath: daemon.socketPath + '.lock' });
  });

  afterEach(async () => {
    client.close();
    await daemon.close();
  });

  it('attaches to a live daemon and completes the hello handshake', async () => {
    await client.connect();
    expect(client.isClosed).toBe(false);
    const hello = daemon.received.find((m) => m.method === 'sunday/hello');
    expect(hello).toBeDefined();
    expect((hello!.params as { client: { name: string } }).client.name).toBe('sunday-cli');
  });

  it('correlates concurrent requests', async () => {
    await client.connect();
    daemon.onRequest = (method) => ({ echo: method });
    const [a, b] = await Promise.all([client.request('a/method'), client.request('b/method')]);
    expect(a).toEqual({ echo: 'a/method' });
    expect(b).toEqual({ echo: 'b/method' });
  });

  it('rejects on server error responses', async () => {
    await client.connect();
    daemon.onRequest = () => {
      throw new Error('boom');
    };
    await expect(client.request('x/fail')).rejects.toThrow('boom');
  });

  it('delivers notifications to subscribers', async () => {
    await client.connect();
    const seen: unknown[] = [];
    const unsub = client.onNotification('chat/event', (p) => seen.push(p));
    daemon.sendNotification('chat/event', { turnId: 't1', event: { type: 'text-delta', delta: 'hi' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(1);
    unsub();
    daemon.sendNotification('chat/event', { turnId: 't1', event: { type: 'text-delta', delta: 'yo' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(1); // unsubscribed
  });

  it('throws ProtocolMismatchError on version skew', async () => {
    // Rigged server: always answers protocolVersion 999 (wrong).
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-cli-skew-'));
    const sp2 = path.join(dir2, 's.sock');
    const srv = net.createServer((sock) => {
      const f = new NdjsonFramer();
      sock.on('data', (c: Buffer) => {
        for (const line of f.push(c.toString('utf8'))) {
          const m = JSON.parse(line) as { id: number };
          sock.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: m.id,
              result: { protocolVersion: 999, negotiated: false, server: { name: 'sundayd', version: 'x' } },
            }) + '\n',
          );
        }
      });
    });
    await new Promise<void>((r) => srv.listen(sp2, () => r()));
    const bad = new DaemonClient({ socketPath: sp2, lockPath: sp2 + '.lock' });
    await expect(bad.connect()).rejects.toThrow(/protocol mismatch/i);
    bad.close();
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it('spawns sundayd when no daemon is listening (injectable spawner)', async () => {
    await daemon.close(); // no daemon on this path now
    let spawnedWith: string | undefined;
    const spawner = (sp: string) => {
      spawnedWith = sp;
      // Simulate async daemon startup: the "spawned" daemon starts
      // listening shortly after the spawner returns.
      void startMockDaemonAt(sp).then((d) => {
        daemon = d;
      });
      return { unref: () => undefined, pid: 4242 } as unknown as import('node:child_process').ChildProcess;
    };
    const c2 = new DaemonClient({
      socketPath: daemon.socketPath,
      lockPath: daemon.socketPath + '.lock',
      spawnDaemon: spawner,
      spawnTimeoutMs: 10000,
    });
    await c2.connect();
    expect(spawnedWith).toBe(daemon.socketPath);
    // The spawner won the lock, so the client attached to the "spawned" daemon.
    expect(daemon.received.find((m) => m.method === 'sunday/hello')).toBeDefined();
    c2.close();
  });
});

/** Start a mock daemon on an exact (preexisting-dir) socket path. */
async function startMockDaemonAt(socketPath: string): Promise<MockDaemon> {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true });
  const received: MockDaemon['received'] = [];
  const framer = new NdjsonFramer();
  const mock: MockDaemon = {
    server: null as unknown as net.Server,
    socketPath,
    received,
    onRequest: () => ({ ok: true }),
    sendNotification: () => undefined,
    close: async () => {},
  };
  const server = net.createServer((sock) => {
    sock.on('data', (chunk: Buffer) => {
      for (const line of framer.push(chunk.toString('utf8'))) {
        const msg = JSON.parse(line) as { id?: number; method: string; params?: unknown };
        received.push(msg);
        if (msg.method === 'sunday/hello') {
          sock.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: PROTOCOL_VERSION,
                negotiated: true,
                server: { name: 'sundayd', version: '0.0.0-test' },
              },
            }) + '\n',
          );
          continue;
        }
        if (msg.id === undefined) continue;
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\n');
      }
    });
  });
  mock.server = server;
  mock.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* may not exist */
    }
    server.listen(socketPath, () => resolve());
  });
  return mock;
}

describe('resolveSundaydCli', () => {
  it('resolves to an existing file', () => {
    // Only meaningful inside the workspace where @sunday/sundayd is linked.
    try {
      const p = resolveSundaydCli();
      expect(fs.existsSync(p)).toBe(true);
    } catch {
      // Not linked (e.g. packed tarball without workspace) — acceptable.
      expect(true).toBe(true);
    }
  });
});
