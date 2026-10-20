/**
 * daemonClient regression tests — a fake daemon process speaks NDJSON
 * JSON-RPC over stdio. These guard two shipped bugs that made EVERY
 * daemon-backed IDE feature fail:
 *  1. ensureDaemon's handshake ping re-entered daemonRpc before
 *     daemonReady was assigned → recursive spawns → circuit breaker.
 *  2. onDaemonData read id/method off parseMessage's {kind, message}
 *     wrapper instead of .message → all responses/notifications dropped.
 */
import { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, it, vi } from 'vitest';

class FakeStdin {
  lines: string[] = [];
  constructor(private readonly onLine: (line: string) => void) {}
  write(chunk: string): boolean {
    this.lines.push(chunk);
    for (const line of chunk.split('\n')) {
      if (line.trim()) this.onLine(line);
    }
    return true;
  }
}

class FakeDaemonProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: FakeStdin;
  killed = false;

  constructor() {
    super();
    this.stdin = new FakeStdin((line) => this.handle(line));
  }

  private emitLine(obj: unknown): void {
    queueMicrotask(() => {
      this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n', 'utf8'));
    });
  }

  private handle(line: string): void {
    let req: { id?: number; method?: string };
    try {
      req = JSON.parse(line) as { id?: number; method?: string };
    } catch {
      return;
    }
    if (req.id === undefined || !req.method) return;
    if (req.method === 'test/notify-then-respond') {
      // Envelope shape exactly as sundayd sends it: ids on the
      // notification, the event nested under `event`.
      this.emitLine({
        jsonrpc: '2.0',
        method: 'chat/event',
        params: {
          turnId: 'turn-42',
          sessionId: 'sess-7',
          event: { type: 'text-delta', delta: 'hello' },
        },
      });
      this.emitLine({
        jsonrpc: '2.0',
        method: 'orchestrate/event',
        params: { runId: 'run-1', unitId: 'u1', phase: 'started' },
      });
    }
    const result =
      req.method === 'sunday/ping' ? { ok: true, time: 'now' } : { echoed: req.method };
    this.emitLine({ jsonrpc: '2.0', id: req.id, result });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const fakeProc = new FakeDaemonProc();
const spawnMock = vi.fn(() => fakeProc);

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { daemonRpc, addChatEventHandler, addNotificationHandler } =
  await import('./daemonClient.js');

describe('daemonClient (fake daemon)', () => {
  beforeAll(() => {
    delete process.env.SUNDAY_DAEMON_UNAVAILABLE;
  });

  it('resolves an RPC with the daemon result (response unwrapping)', async () => {
    const res = (await daemonRpc('session/list', {})) as { echoed?: string };
    expect(res.echoed).toBe('session/list');
  });

  it('spawns the daemon exactly once across sequential RPCs (no handshake recursion)', async () => {
    await daemonRpc('sunday/ping', {});
    await daemonRpc('session/list', {});
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('delivers chat/event notifications with turnId/sessionId merged from the envelope', async () => {
    const seen: unknown[] = [];
    addChatEventHandler((ev) => seen.push(ev));
    await daemonRpc('test/notify-then-respond', {});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'text-delta',
      delta: 'hello',
      turnId: 'turn-42',
      sessionId: 'sess-7',
    });
  });

  it('routes generic notifications (orchestrate/event) to registered handlers', async () => {
    const seen: unknown[] = [];
    addNotificationHandler('orchestrate/event', (p) => seen.push(p));
    await daemonRpc('test/notify-then-respond', {});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ runId: 'run-1', unitId: 'u1', phase: 'started' });
  });
});
