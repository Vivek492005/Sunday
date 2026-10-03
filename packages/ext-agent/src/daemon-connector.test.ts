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
} from './daemon-connector.js';

const FIXTURE = fileURLToPath(new URL('./test/fixtures/mini-socket-sundayd.mjs', import.meta.url));

const tmpDirs: string[] = [];
const connectors: DaemonConnector[] = [];
const procs: ChildProcess[] = [];

function socketPath(): string {
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

describe('DaemonConnector', () => {
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
});
