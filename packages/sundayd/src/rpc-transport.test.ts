/**
 * Phase 8 Stage 1 — tests for the shared NDJSON codec (`rpc-transport.ts`).
 * No daemon, no network beyond loopback unix sockets.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  NdjsonFramer,
  SocketServerTransport,
  dispatchRequestLine,
  encodeFrame,
  toErrorResponse,
  RpcError,
} from './rpc-transport.js';
import { ErrorCode } from '@sunday/protocol';

const tmpSockets: string[] = [];
function socketPath(): string {
  // Windows uses named pipes, not Unix sockets.
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\sunday-sock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-sock-')),
    'test.sock',
  );
  tmpSockets.push(path.dirname(p));
  return p;
}
afterEach(() => {
  for (const d of tmpSockets.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('encodeFrame', () => {
  it('emits one JSON object per newline-terminated line', () => {
    expect(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'x' })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"x"}\n',
    );
  });
});

describe('NdjsonFramer', () => {
  it('splits complete lines and holds partial ones', () => {
    const f = new NdjsonFramer();
    expect(f.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(f.push('2}\n')).toEqual(['{"b":2}']);
    expect(f.push('')).toEqual([]);
  });

  it('emits several lines from one chunk and strips CR', () => {
    const f = new NdjsonFramer();
    expect(f.push('one\r\ntwo\nthree\r\n')).toEqual(['one', 'two', 'three']);
  });

  it('keeps an unterminated tail across pushes', () => {
    const f = new NdjsonFramer();
    f.push('abc');
    f.push('def');
    expect(f.push('\n')).toEqual(['abcdef']);
  });
});

describe('toErrorResponse', () => {
  it('maps RpcError to its code/message/data', () => {
    const r = toErrorResponse(7, new RpcError(-32001, 'nope', { x: 1 }));
    expect(r).toMatchObject({ id: 7, error: { code: -32001, message: 'nope', data: { x: 1 } } });
  });

  it('maps unknown errors to InternalError', () => {
    const r = toErrorResponse(7, new Error('boom'));
    expect(r).toMatchObject({ id: 7, error: { code: ErrorCode.InternalError, message: 'boom' } });
  });
});

describe('dispatchRequestLine', () => {
  it('runs the handler and writes a success response', async () => {
    const written: unknown[] = [];
    await dispatchRequestLine(
      '{"jsonrpc":"2.0","id":3,"method":"sunday/ping","params":{}}',
      async () => ({ ok: true }),
      (m) => written.push(m),
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ jsonrpc: '2.0', id: 3, result: { ok: true } });
  });

  it('writes an error response when the handler throws', async () => {
    const written: unknown[] = [];
    await dispatchRequestLine(
      '{"jsonrpc":"2.0","id":4,"method":"x","params":{}}',
      async () => {
        throw new RpcError(ErrorCode.MethodNotFound, 'unknown method: x');
      },
      (m) => written.push(m),
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      id: 4,
      error: { code: ErrorCode.MethodNotFound, message: 'unknown method: x' },
    });
  });

  it('answers ParseError (id null) for unparseable lines', async () => {
    const written: unknown[] = [];
    await dispatchRequestLine('this is not json', async () => ({}), (m) => written.push(m));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ id: null, error: { code: ErrorCode.ParseError } });
  });

  it('ignores inbound notifications and responses', async () => {
    const written: unknown[] = [];
    let called = 0;
    const handler = async () => {
      called += 1;
      return {};
    };
    await dispatchRequestLine(
      '{"jsonrpc":"2.0","method":"chat/event","params":{}}',
      handler,
      (m) => written.push(m),
    );
    await dispatchRequestLine(
      '{"jsonrpc":"2.0","id":9,"result":{}}',
      handler,
      (m) => written.push(m),
    );
    expect(called).toBe(0);
    expect(written).toHaveLength(0);
  });
});

// Windows named-pipe support enabled 2026-10-05 (see daemon-connector.test.ts).
const describeWin = describe;

describeWin('SocketServerTransport', () => {
  it('round-trips a request/response over a unix socket', async () => {
    const p = socketPath();
    const server = net.createServer((sock) => {
      const t = new SocketServerTransport(sock, async (req) => ({ echo: req.params }));
      t.start();
    });
    await new Promise<void>((res) => server.listen(p, res));
    try {
      const client = net.connect(p);
      const reply = await new Promise<string>((resolve, reject) => {
        let buf = '';
        client.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
          const i = buf.indexOf('\n');
          if (i >= 0) resolve(buf.slice(0, i));
        });
        client.on('error', reject);
        client.write('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"a":1}}\n');
      });
      expect(JSON.parse(reply)).toMatchObject({ id: 1, result: { echo: { a: 1 } } });
      client.destroy();
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('delivers server notifications and handles several frames per chunk', async () => {
    const p = socketPath();
    let serverTransport: SocketServerTransport | undefined;
    const server = net.createServer((sock) => {
      serverTransport = new SocketServerTransport(sock, async () => ({ ok: true }));
      serverTransport.start();
    });
    await new Promise<void>((res) => server.listen(p, res));
    try {
      const client = net.connect(p);
      const lines: string[] = [];
      const gotAll = new Promise<void>((resolve) => {
        let buf = '';
        client.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            lines.push(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
          if (lines.length >= 3) resolve();
        });
      });
      await new Promise((r) => setTimeout(r, 100));
      // Two requests in one chunk + one server notification.
      client.write(
        '{"jsonrpc":"2.0","id":1,"method":"a","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"b","params":{}}\n',
      );
      serverTransport!.notify('chat/event', { n: 1 });
      await gotAll;
      const methods = lines.map((l) => JSON.parse(l));
      expect(methods.filter((m) => m.id === 1)).toHaveLength(1);
      expect(methods.filter((m) => m.id === 2)).toHaveLength(1);
      expect(methods.find((m) => m.method === 'chat/event')).toMatchObject({ params: { n: 1 } });
      client.destroy();
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('answers ParseError for garbage and fires onClose on disconnect', async () => {
    const p = socketPath();
    let closed = false;
    const server = net.createServer((sock) => {
      const t = new SocketServerTransport(sock, async () => ({}), {
        onClose: () => {
          closed = true;
        },
      });
      t.start();
    });
    await new Promise<void>((res) => server.listen(p, res));
    try {
      const client = net.connect(p);
      const reply = await new Promise<string>((resolve) => {
        let buf = '';
        client.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
          const i = buf.indexOf('\n');
          if (i >= 0) resolve(buf.slice(0, i));
        });
        client.write('garbage line\n');
      });
      expect(JSON.parse(reply)).toMatchObject({ id: null, error: { code: ErrorCode.ParseError } });
      client.destroy();
      await new Promise((r) => setTimeout(r, 100));
      expect(closed).toBe(true);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
