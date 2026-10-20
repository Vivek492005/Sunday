/**
 * extensionHostManager regression tests — a fake host process speaks
 * NDJSON JSON-RPC over stdio. These guard the shipped 2.1.0 CRITICAL
 * (safety audit C1): ensureExtensionHost's handshake ping re-entered
 * extHostRpc before hostReady was assigned → recursive spawns until the
 * circuit breaker rejected the call, the rejected promise was cached
 * forever, and up to 3 host processes were orphaned — every extension
 * feature was dead for the whole session. This module had ZERO tests,
 * which is how it shipped.
 *
 * Tests share one module instance (hostReady/spawn counters are
 * module-level state), so they run in file order and reset state by
 * emitting 'exit' on the current fake host.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

type FakeMode = 'ok' | 'silent' | 'error';

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

class FakeHostProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: FakeStdin;
  killed = false;

  constructor(private readonly mode: FakeMode) {
    super();
    this.stdin = new FakeStdin((line) => this.handle(line));
    if (mode === 'error') {
      queueMicrotask(() => this.emit('error', new Error('spawn blew up')));
    }
  }

  private handle(line: string): void {
    if (this.mode !== 'ok') return; // 'silent' never answers; 'error' already failed
    let req: { id?: number; method?: string };
    try {
      req = JSON.parse(line) as { id?: number; method?: string };
    } catch {
      return;
    }
    if (req.id === undefined || !req.method) return;
    const result = req.method === 'extHost/ping' ? 'pong' : { echoed: req.method };
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
const procs: FakeHostProc[] = [];
const spawnMock = vi.fn(() => {
  const proc = new FakeHostProc(modes.shift() ?? 'ok');
  procs.push(proc);
  return proc;
});

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

// hostBin() resolves exthost.cjs next to the module; under vitest that is
// the source dir, where no bundle exists. Pretend it is built so the
// manager reaches the spawn path; every other path stays real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: unknown): boolean =>
    String(p).endsWith('exthost.cjs') ? true : actual.existsSync(p as string);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

const { extHostRpc } = await import('./extensionHostManager.js');

afterEach(() => {
  vi.useRealTimers();
});

describe('extensionHostManager (fake host)', () => {
  it('first extHostRpc ping succeeds and exactly ONE host spawns across calls', async () => {
    modes.push('ok');
    const pong = await extHostRpc('extHost/ping', {});
    expect(pong).toBe('pong');
    const scan = (await extHostRpc('extHost/scan', {})) as { echoed?: string };
    expect(scan.echoed).toBe('extHost/scan');
    // The C1 regression: the handshake used to recurse into 3 spawns and a
    // circuit-breaker rejection on the very first call.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(procs[0].killed).toBe(false);
  });

  it('a spawn failure clears state so the next call retries with a fresh host', async () => {
    procs[0].emit('exit', 0); // retire the healthy host from the previous test
    modes.push('error');
    await expect(extHostRpc('extHost/ping', {})).rejects.toThrow('spawn blew up');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    modes.push('ok');
    const pong = await extHostRpc('extHost/ping', {});
    expect(pong).toBe('pong');
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it('a hung host is killed on ping timeout and the next call respawns cleanly', async () => {
    procs[2].emit('exit', 0); // retire the healthy host
    vi.useFakeTimers();
    // Slide past the 60s circuit-breaker window (3 attempts so far).
    vi.setSystemTime(Date.now() + 61_000);
    modes.push('silent');
    const call = extHostRpc('extHost/ping', {});
    const assertion = expect(call).rejects.toThrow('extension host ping timeout');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(spawnMock).toHaveBeenCalledTimes(4);
    // The hung process must be KILLED, not orphaned with a cached rejection.
    expect(procs[3].killed).toBe(true);
    modes.push('ok');
    const pong = await extHostRpc('extHost/ping', {});
    expect(pong).toBe('pong');
    expect(spawnMock).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });
});
