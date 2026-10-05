/**
 * Phase 8 Stage 1 — RpcClient over a socket (`RpcClient.fromSocket`).
 * A fake NDJSON server on a loopback unix socket; no daemon, no network.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { RpcClient, RpcTimeoutError, RpcClosedError } from './rpc.js';

const tmpDirs: string[] = [];
const servers: net.Server[] = [];
const clients: RpcClient[] = [];
const sockets: net.Socket[] = [];

function socketPath(): string {
  // Windows uses named pipes, not Unix sockets.
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\sunday-rpc-test-${Date.now()}`;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-rpc-'));
  tmpDirs.push(dir);
  return path.join(dir, 'test.sock');
}

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
  // Destroy client sockets first: RpcClient.close() intentionally leaves the
  // socket alone (owner's job), and server.close() waits for connections.
  for (const s of sockets.splice(0)) {
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
  }
  for (const s of servers.splice(0)) {
    await new Promise<void>((res) => {
      const t = setTimeout(res, 3000);
      t.unref?.();
      s.close(() => {
        clearTimeout(t);
        res();
      });
    });
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

interface FakeServer {
  server: net.Server;
  /** Lines received from the client. */
  received: string[];
  /** Send a raw line to the client. */
  send(line: string): void;
}

/** Fake NDJSON server: answers `sunday/ping`, emits a notification on `chat/send`. */
async function startFakeServer(opts: { silent?: boolean } = {}): Promise<FakeServer & { path: string }> {
  const p = socketPath();
  const received: string[] = [];
  let sock: net.Socket | undefined;
  const server = net.createServer((s) => {
    sock = s;
    let buf = '';
    s.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        received.push(line);
        if (opts.silent) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          if (msg.method === 'sunday/ping') {
            s.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\n');
          } else if (msg.method === 'chat/send') {
            s.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turnId: 't1' } }) + '\n');
            s.write(JSON.stringify({ jsonrpc: '2.0', method: 'chat/event', params: { n: 1 } }) + '\n');
          } else {
            s.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }) + '\n',
            );
          }
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(p, res));
  return {
    server,
    received,
    path: p,
    send: (line: string) => sock?.write(line + '\n'),
  };
}

async function connectClient(p: string): Promise<RpcClient> {
  const socket = net.connect(p);
  sockets.push(socket);
  await new Promise<void>((res, rej) => {
    socket.once('connect', () => res());
    socket.once('error', rej);
  });
  const client = RpcClient.fromSocket(socket);
  clients.push(client);
  return client;
}

// Windows named-pipe support enabled 2026-10-05 (see daemon-connector.test.ts).
const describeWin = describe;

describeWin('RpcClient.fromSocket', () => {
  it('correlates concurrent requests over the socket', async () => {
    const fake = await startFakeServer();
    const client = await connectClient(fake.path);
    const [a, b] = await Promise.all([client.request('sunday/ping', {}), client.request('sunday/ping', {})]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(fake.received).toHaveLength(2);
  });

  it('delivers server notifications to subscribers', async () => {
    const fake = await startFakeServer();
    const client = await connectClient(fake.path);
    const seen: unknown[] = [];
    const off = client.onNotification('chat/event', (p) => seen.push(p));
    await client.request('chat/send', {});
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual([{ n: 1 }]);
    off();
    await client.request('chat/send', {});
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toHaveLength(1);
  });

  it('surfaces server errors as RpcError', async () => {
    const fake = await startFakeServer();
    const client = await connectClient(fake.path);
    await expect(client.request('nope/method', {})).rejects.toMatchObject({ code: -32601 });
  });

  it('times out when the server never responds', async () => {
    const fake = await startFakeServer({ silent: true });
    const client = await connectClient(fake.path);
    await expect(client.request('sunday/ping', {}, { timeoutMs: 150 })).rejects.toBeInstanceOf(
      RpcTimeoutError,
    );
  });

  it('closes when the socket dies and rejects new requests', async () => {
    const fake = await startFakeServer();
    const client = await connectClient(fake.path);
    expect(client.isClosed).toBe(false);
    // Kill the underlying socket; the client's terminated handler must fire.
    for (const s of sockets.splice(0)) s.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(client.isClosed).toBe(true);
    await expect(client.request('sunday/ping', {})).rejects.toBeInstanceOf(RpcClosedError);
  });

  it('reports malformed lines via onMalformedLine', async () => {
    const fake = await startFakeServer();
    const client = await connectClient(fake.path);
    const bad: string[] = [];
    client.onMalformedLine = (l) => bad.push(l);
    fake.send('not json at all');
    await new Promise((r) => setTimeout(r, 200));
    expect(bad).toEqual(['not json at all']);
  });
});
