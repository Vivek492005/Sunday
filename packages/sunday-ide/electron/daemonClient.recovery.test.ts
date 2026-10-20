/**
 * daemonClient recovery regression tests (audit M1).
 *
 * A hung-but-alive daemon (never answers the handshake ping) used to be
 * unrecoverable: the 15s ping timeout rejected ensureDaemon(), but
 * daemonReady was never reset and the zombie process was never killed —
 * every later RPC instantly returned the cached rejection (agent chat,
 * Ops, missions all dead until IDE restart). These tests use a fake
 * daemon that stays silent on the first spawn and answers on the second.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type FakeMode = 'ok' | 'silent';

class FakeStdin extends EventEmitter {
  lines: string[] = [];
  constructor(private readonly onLine: (line: string) => void) {
    super();
  }
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

  constructor(private readonly mode: FakeMode) {
    super();
    this.stdin = new FakeStdin((line) => this.handle(line));
  }

  private handle(line: string): void {
    if (this.mode !== 'ok') return; // 'silent' never answers the ping
    let req: { id?: number; method?: string };
    try {
      req = JSON.parse(line) as { id?: number; method?: string };
    } catch {
      return;
    }
    if (req.id === undefined || !req.method) return;
    const result = req.method === 'sunday/ping' ? { ok: true } : { echoed: req.method };
    queueMicrotask(() => {
      this.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n', 'utf8'));
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const modes: FakeMode[] = [];
const procs: FakeDaemonProc[] = [];
const spawnMock = vi.fn(() => {
  const proc = new FakeDaemonProc(modes.shift() ?? 'ok');
  procs.push(proc);
  return proc;
});

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { daemonRpc } = await import('./daemonClient.js');

beforeAll(() => {
  delete process.env.SUNDAY_DAEMON_UNAVAILABLE;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('daemonClient hung-daemon recovery (audit M1)', () => {
  it('ping timeout kills the hung daemon, clears state, and the next RPC respawns cleanly', async () => {
    vi.useFakeTimers();
    modes.push('silent');
    const call = daemonRpc('session/list', {});
    const assertion = expect(call).rejects.toThrow('daemon ping timeout');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The zombie must be killed — not retained for the rest of the session.
    expect(procs[0].killed).toBe(true);

    // Pre-fix, this call returned the same cached rejection instantly.
    modes.push('ok');
    const res = (await daemonRpc('session/list', {})) as { echoed?: string };
    expect(res.echoed).toBe('session/list');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('drops an over-cap newline-free flood instead of poisoning the channel (audit M2)', async () => {
    // Runs against the healthy daemon spawned by the previous test.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 17MB with no newline: pre-fix this stayed in rpcBuffer forever
      // and glued itself to the next response line, making it
      // unparseable — the RPC below would time out instead of resolving.
      procs[1].stdout.emit('data', Buffer.alloc(17 * 1024 * 1024, 0x78));
      const res = (await daemonRpc('session/list', {}, 2000)) as { echoed?: string };
      expect(res.echoed).toBe('session/list');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('RPC buffer exceeded'));
    } finally {
      errSpy.mockRestore();
    }
  });
});
