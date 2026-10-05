/**
 * Phase 8 Stage 1 — DaemonConnector tests.
 * Uses the hermetic mini-socket-sundayd fixture (real child processes,
 * loopback unix sockets). No network, no API keys.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  DaemonConnector,
  DaemonSpawnError,
  ProtocolMismatchError,
  defaultSocketPath,
  sharedDaemonSocketPath,
  sharedDaemonLockPath,
} from './daemon-connector.js';
import { isPidAlive, readDaemonLock } from '@sunday/protocol';

const FIXTURE = fileURLToPath(new URL('./test/fixtures/mini-socket-sundayd.mjs', import.meta.url));

const tmpDirs: string[] = [];
const connectors: DaemonConnector[] = [];
const procs: ChildProcess[] = [];

function socketPath(): string {
  // Windows uses named pipes, not Unix sockets.
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\sunday-test-${Date.now()}`;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-conn-'));
  tmpDirs.push(dir);
  return path.join(dir, 'daemon.sock');
}

afterEach(async () => {
  for (const c of connectors.splice(0)) {
    try {
      await c.dispose();
    } catch {
      /* ignore */
    }
  }
  for (const p of procs.splice(0)) {
    try {
      if (p.exitCode === null) p.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function spawnFixture(socket: string, extraArgs: string[] = []): ChildProcess {
  const p = spawn(process.execPath, [FIXTURE, '--socket', socket, ...extraArgs], {
    stdio: 'ignore',
    windowsHide: true,
  });
  procs.push(p);
  return p;
}

/** Wait until the socket accepts connections (fixture is listening). */
async function waitForSocket(p: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(p);
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for socket ${p}`);
}

function track(c: DaemonConnector): DaemonConnector {
  connectors.push(c);
  return c;
}

// Windows named-pipe support: socketPath() returns \\.\pipe\... on win32,
// and the mini-socket-sundayd fixture listens on named pipes natively.
// Enabled on all platforms 2026-10-05.
const describeWin = describe;

describeWin('DaemonConnector', () => {
  it('attaches to an already-listening daemon without spawning', async () => {
    const sock = socketPath();
    spawnFixture(sock);
    await waitForSocket(sock);

    const spawnDaemon = vi.fn(() => spawnFixture(sock));
    const c = track(
      new DaemonConnector({ socketPath: sock, spawnDaemon, clientVersion: '1.2.3-test' }),
    );
    const rpc = await c.connect();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(c.ownsDaemon).toBe(false);
    const ping = await rpc.request('sunday/ping', {});
    expect(ping).toEqual({ ok: true });
  });

  it('spawns sundayd --socket when nothing listens, then connects', async () => {
    const sock = socketPath();
    const spawned: string[][] = [];
    const c = track(
      new DaemonConnector({
        socketPath: sock,
        spawnDaemon: () => {
          spawned.push(['--socket', sock]);
          return spawnFixture(sock);
        },
        clientVersion: '1.2.3-test',
        spawnTimeoutMs: 10000,
      }),
    );
    const rpc = await c.connect();
    expect(spawned).toEqual([['--socket', sock]]);
    expect(c.ownsDaemon).toBe(true);
    const ping = await rpc.request('sunday/ping', {});
    expect(ping).toEqual({ ok: true });
  });

  it('dispose() shuts down the owned daemon and clears state', async () => {
    const sock = socketPath();
    let child: ChildProcess | undefined;
    const c = track(
      new DaemonConnector({
        socketPath: sock,
        spawnDaemon: () => {
          child = spawnFixture(sock);
          return child;
        },
        clientVersion: '1.2.3-test',
        spawnTimeoutMs: 10000,
      }),
    );
    await c.connect();
    expect(c.ownsDaemon).toBe(true);
    await c.dispose();
    // The fixture exits on sunday/shutdown; give the SIGKILL fallback a beat.
    await new Promise((r) => setTimeout(r, 300));
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(c.getRpc()).toBeUndefined();
  });

  it('does not kill a daemon it did not spawn on dispose', async () => {
    const sock = socketPath();
    // --no-shutdown-exit: the polite sunday/shutdown RPC must NOT take it
    // down; only an owned child gets SIGTERM/SIGKILL.
    const external = spawnFixture(sock, ['--no-shutdown-exit']);
    await waitForSocket(sock);
    const c = track(
      new DaemonConnector({
        socketPath: sock,
        spawnDaemon: () => {
          throw new Error('must not spawn');
        },
        clientVersion: '1.2.3-test',
      }),
    );
    await c.connect();
    expect(c.ownsDaemon).toBe(false);
    await c.dispose();
    await new Promise((r) => setTimeout(r, 300));
    // The externally-owned fixture is still alive.
    expect(external.exitCode).toBeNull();
  });

  it('throws DaemonSpawnError when the spawn function throws', async () => {
    const sock = socketPath();
    const c = track(
      new DaemonConnector({
        socketPath: sock,
        spawnDaemon: () => {
          throw new Error('ENOENT');
        },
        clientVersion: '1.2.3-test',
        spawnTimeoutMs: 1000,
      }),
    );
    await expect(c.connect()).rejects.toBeInstanceOf(DaemonSpawnError);
  });

  it('throws ProtocolMismatchError on version skew', async () => {
    const sock = socketPath();
    const c = track(
      new DaemonConnector({
        socketPath: sock,
        spawnDaemon: () => spawnFixture(sock, ['--protocol-version', '999']),
        clientVersion: '1.2.3-test',
        spawnTimeoutMs: 10000,
      }),
    );
    await expect(c.connect()).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it('defaultSocketPath() is a per-process unix socket path', () => {
    const p = defaultSocketPath();
    expect(p).toContain('.sunday');
    expect(p).toContain(String(process.pid));
    expect(p.endsWith('.sock')).toBe(true);
  });

  it('configureWorkspace() sends daemon/configure + mcp/secrets/provide', async () => {
    const sock = socketPath();
    const recordFile = path.join(path.dirname(sock), 'record.jsonl');
    spawnFixture(sock, ['--record-file', recordFile]);
    await waitForSocket(sock);

    const c = track(
      new DaemonConnector({
        socketPath: sock,
        spawnDaemon: () => spawnFixture(sock),
        clientVersion: '1.2.3-test',
      }),
    );
    await c.connect();
    await c.configureWorkspace({
      workspaceRoot: '/tmp/ws-a',
      trusted: true,
      mcpSecrets: { API_KEY: 'aaa' },
    });

    const lines = fs
      .readFileSync(recordFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.method).toBe('daemon/configure');
    expect(lines[0]?.params).toMatchObject({ workspaceRoot: '/tmp/ws-a', trusted: true });
    expect(lines[1]?.method).toBe('mcp/secrets/provide');
    expect(lines[1]?.params).toMatchObject({
      workspaceRoot: '/tmp/ws-a',
      secrets: { API_KEY: 'aaa' },
    });
  });

  it('configureWorkspace() skips secrets when none are provided', async () => {
    const sock = socketPath();
    const recordFile = path.join(path.dirname(sock), 'record.jsonl');
    spawnFixture(sock, ['--record-file', recordFile]);
    await waitForSocket(sock);

    const c = track(
      new DaemonConnector({
        socketPath: sock,
        spawnDaemon: () => spawnFixture(sock),
        clientVersion: '1.2.3-test',
      }),
    );
    await c.connect();
    await c.configureWorkspace({ workspaceRoot: '/tmp/ws-a', trusted: false });

    const lines = fs
      .readFileSync(recordFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.method).toBe('daemon/configure');
    expect(lines[0]?.params).toMatchObject({ workspaceRoot: '/tmp/ws-a', trusted: false });
  });

  it('configureWorkspace() throws before connect()', async () => {
    const c = track(
      new DaemonConnector({
        socketPath: socketPath(),
        spawnDaemon: () => spawnFixture(socketPath()),
        clientVersion: '1.2.3-test',
      }),
    );
    await expect(c.configureWorkspace({ workspaceRoot: '/tmp/ws' })).rejects.toThrow(
      /before connect/,
    );
  });
});

describeWin('DaemonConnector single-flight (Stage 2)', () => {
  /** Hermetic per-user socket + lock pair (never touches the real ~/.sunday). */
  function sharedPaths(): { sock: string; lock: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-sf-'));
    tmpDirs.push(dir);
    return { sock: path.join(dir, 'sundayd.sock'), lock: path.join(dir, 'sundayd.lock') };
  }

  function writeLock(lock: string, pid: number): void {
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid, socketPath: 'x', startedAt: new Date().toISOString(), version: 1 }),
    );
  }

  it(
    'second connector attaches to the same daemon without spawning',
    { timeout: 20000 },
    async () => {
      const { sock, lock } = sharedPaths();
      const spawnDaemon = vi.fn(() => spawnFixture(sock));
      const a = track(
        new DaemonConnector({
          socketPath: sock,
          spawnDaemon,
          clientVersion: '1.2.3-test',
          singleFlight: { lockPath: lock },
          spawnTimeoutMs: 10000,
        }),
      );
      const rpcA = await a.connect();
      expect(spawnDaemon).toHaveBeenCalledTimes(1);
      expect(a.ownsDaemon).toBe(true);
      expect(await rpcA.request('sunday/ping', {})).toEqual({ ok: true });

      const spawnB = vi.fn((): ChildProcess => {
        throw new Error('second window must not spawn');
      });
      const b = track(
        new DaemonConnector({
          socketPath: sock,
          spawnDaemon: spawnB,
          clientVersion: '1.2.3-test',
          singleFlight: { lockPath: lock },
        }),
      );
      const rpcB = await b.connect();
      expect(spawnB).not.toHaveBeenCalled();
      expect(b.ownsDaemon).toBe(false);
      expect(await rpcB.request('sunday/ping', {})).toEqual({ ok: true });

      // Disposing either window must NOT shut down or kill the shared daemon.
      await b.dispose();
      await a.dispose();
      await new Promise((r) => setTimeout(r, 400));
      // Still listening: the fixture would have exited 50ms after a
      // sunday/shutdown RPC, and would be dead had it been SIGKILLed.
      await waitForSocket(sock);
    },
  );

  it(
    'waits for another spawner when the lock is held by a live pid',
    { timeout: 20000 },
    async () => {
      const { sock, lock } = sharedPaths();
      // Simulate another window mid-spawn: live PID (our own), socket not up yet.
      writeLock(lock, process.pid);
      const spawnDaemon = vi.fn((): ChildProcess => {
        throw new Error('loser must not spawn');
      });
      const c = track(
        new DaemonConnector({
          socketPath: sock,
          spawnDaemon,
          clientVersion: '1.2.3-test',
          singleFlight: { lockPath: lock, acquireTimeoutMs: 10000 },
        }),
      );
      // The "other window's" daemon comes up shortly after.
      const timer = setTimeout(() => spawnFixture(sock), 500);
      try {
        const rpc = await c.connect();
        expect(spawnDaemon).not.toHaveBeenCalled();
        expect(c.ownsDaemon).toBe(false);
        expect(await rpc.request('sunday/ping', {})).toEqual({ ok: true });
      } finally {
        clearTimeout(timer);
      }
    },
  );

  it(
    'steals a stale lock (dead pid) and spawns',
    { timeout: 20000 },
    async () => {
      const { sock, lock } = sharedPaths();
      // Deterministic dead PID: a child that has already exited.
      const doomed = spawn(process.execPath, ['--version']);
      const deadPid = doomed.pid as number;
      await new Promise<void>((resolve) => doomed.on('exit', () => resolve()));
      expect(isPidAlive(deadPid)).toBe(false);
      writeLock(lock, deadPid);

      const spawnDaemon = vi.fn(() => spawnFixture(sock));
      const c = track(
        new DaemonConnector({
          socketPath: sock,
          spawnDaemon,
          clientVersion: '1.2.3-test',
          singleFlight: { lockPath: lock },
          spawnTimeoutMs: 10000,
        }),
      );
      const rpc = await c.connect();
      expect(spawnDaemon).toHaveBeenCalledTimes(1);
      expect(await rpc.request('sunday/ping', {})).toEqual({ ok: true });
      // The stolen lock now names us.
      expect(readDaemonLock(lock)?.pid).toBe(process.pid);
    },
  );

  it('times out cleanly when the lock holder never serves a socket', { timeout: 20000 }, async () => {
    const { sock, lock } = sharedPaths();
    writeLock(lock, process.pid); // live holder, but no daemon ever appears
    const c = track(
      new DaemonConnector({
        socketPath: sock,
        spawnDaemon: () => {
          throw new Error('must not spawn');
        },
        clientVersion: '1.2.3-test',
        singleFlight: { lockPath: lock, acquireTimeoutMs: 1500, pollIntervalMs: 100 },
      }),
    );
    await expect(c.connect()).rejects.toBeInstanceOf(DaemonSpawnError);
  });

  it('sharedDaemonSocketPath()/sharedDaemonLockPath() follow the per-user convention', () => {
    const sock = sharedDaemonSocketPath();
    const lock = sharedDaemonLockPath();
    if (process.platform === 'win32') {
      expect(sock.startsWith('\\\\.\\pipe\\sundayd-')).toBe(true);
    } else {
      expect(sock.endsWith(`${path.sep}.sunday${path.sep}sundayd.sock`)).toBe(true);
    }
    expect(lock.endsWith(`${path.sep}.sunday${path.sep}sundayd.lock`)).toBe(true);
    // Windows named-pipe branch, exercised via overrides on any platform.
    expect(sharedDaemonSocketPath({ platform: 'win32', username: 'bob' })).toBe(
      '\\\\.\\pipe\\sundayd-bob',
    );
    expect(sharedDaemonSocketPath({ platform: 'win32', username: 'b ob!' })).toBe(
      '\\\\.\\pipe\\sundayd-b_ob_',
    );
    expect(sharedDaemonSocketPath({ platform: 'win32', username: '' })).toBe(
      '\\\\.\\pipe\\sundayd-user',
    );
  });

  it('isPidAlive() distinguishes live and dead pids', async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    const doomed = spawn(process.execPath, ['--version']);
    const deadPid = doomed.pid as number;
    await new Promise<void>((resolve) => doomed.on('exit', () => resolve()));
    expect(isPidAlive(deadPid)).toBe(false);
  });
});
