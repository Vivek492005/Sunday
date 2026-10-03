/**
 * Phase 8 Stage 1 — DaemonConnector: connect the extension to sundayd over a
 * socket, spawning `sundayd --socket <path>` when nothing is listening.
 *
 * Phase 8 Stage 2 — single-flight per-user daemon: when `singleFlight` is
 * set, the connector first tries the well-known per-user socket
 * (`sharedDaemonSocketPath()`); on failure it arbitrates via the lockfile
 * mutex (`sharedDaemonLockPath()`): the winner spawns one *shared* daemon
 * (never killed on dispose), losers poll for the winner's socket, and stale
 * locks (dead PID) are stolen. Without `singleFlight` the connector keeps
 * Stage 1 semantics: one daemon per window, owned and shut down on dispose.
 *
 * Wiring into `extension.ts` (replacing SidecarManager) is Stage 2 work;
 * this module is deliberately decoupled from command resolution — the
 * caller injects `spawnDaemon` — so it stays unit-testable.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import {
  PROTOCOL_VERSION,
  helloResultSchema,
  type HelloResult,
  acquireDaemonLock,
  isPidAlive,
  readDaemonLock,
  releaseDaemonLockIfOurs,
} from '@sunday/protocol';
import { RpcClient } from './rpc.js';
// Re-exported for callers/tests so the well-known paths have one import surface.
export { sharedDaemonSocketPath, sharedDaemonLockPath, isSharedDaemonSocket } from '@sunday/protocol';

export class DaemonConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonConnectorError';
  }
}

/** Spawning `sundayd --socket` failed, or it never became reachable. */
export class DaemonSpawnError extends DaemonConnectorError {
  constructor(detail: string) {
    super(`could not start sundayd: ${detail}`);
    this.name = 'DaemonSpawnError';
  }
}

/** `sunday/hello` version negotiation failed. */
export class ProtocolMismatchError extends DaemonConnectorError {
  constructor(detail: string) {
    super(detail);
    this.name = 'ProtocolMismatchError';
  }
}

/**
 * Phase 8 Stage 2 — single-flight options. When set, `connect()` arbitrates
 * one shared daemon per OS user via the lockfile mutex instead of spawning
 * a private per-window daemon:
 *
 * 1. Try the socket — a live daemon may already own it → attach.
 * 2. `wx`-create the lockfile → we won → spawn the shared daemon, connect.
 * 3. Lock held by a live PID → poll for the winner's socket until
 *    `acquireTimeoutMs` (another window is spawning).
 * 4. Lock held by a dead PID → steal it (unlink) and retry from 2.
 *
 * In single-flight mode `dispose()` never shuts the daemon down and never
 * kills the child: the daemon outlives windows by design. Callers should
 * inject a *detached* `spawnDaemon` (`detached: true, stdio: 'ignore'`) so
 * the daemon survives the spawning window too.
 */
export interface SingleFlightOptions {
  /** Lockfile path for the spawn mutex (see `sharedDaemonLockPath()`). */
  lockPath: string;
  /** How long a loser waits for the winner's socket. Default 15000ms. */
  acquireTimeoutMs?: number;
  /** Poll interval while waiting for the winner's socket. Default 100ms. */
  pollIntervalMs?: number;
}

export interface DaemonConnectorOptions {
  /**
   * Socket path (unix domain socket) or named pipe (`\\\\.\\pipe\\…` on
   * Windows) the daemon listens on.
   */
  socketPath: string;
  /**
   * Spawn `sundayd --socket <socketPath>`. Called only when no live daemon
   * answers on the socket. The returned child is owned by the connector.
   */
  spawnDaemon: () => ChildProcess;
  /** sunday-agent version, sent in `sunday/hello`. */
  clientVersion: string;
  /** Hello handshake timeout. Default 15000ms. */
  handshakeTimeoutMs?: number;
  /** How long to wait for the socket after spawning. Default 15000ms. */
  spawnTimeoutMs?: number;
  /**
   * Enable single-flight per-user daemon startup (Stage 2). When unset,
   * Stage 1 semantics apply: `socketPath` is private to this window and
   * the spawned daemon is owned (shut down + killed on dispose).
   */
  singleFlight?: SingleFlightOptions;
  log?: (msg: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Connect to the socket; rejects on timeout or refusal. */
function openSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const timer = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      reject(new DaemonConnectorError(`timed out connecting to ${socketPath} (${timeoutMs}ms)`));
    }, timeoutMs);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    });
  });
}

/**
 * Default socket path for Stage 1. Unique per process so each window keeps
 * its own daemon (today's topology). Stage 2 switches this to the shared
 * per-user path (`~/.sunday/sundayd.sock`).
 */
export function defaultSocketPath(): string {
  return path.join(homedir(), '.sunday', 'sockets', `sundayd-${process.pid}.sock`);
}

export class DaemonConnector {
  /** Owned child (spawn path only). Undefined when attached to an existing daemon. */
  private proc: ChildProcess | undefined;
  private rpc: RpcClient | undefined;
  private socket: net.Socket | undefined;

  constructor(private readonly opts: DaemonConnectorOptions) {}

  /**
   * Connect to the daemon: try the socket first (a live daemon may already
   * own it); otherwise spawn `sundayd --socket <path>` and connect to that.
   * With `singleFlight` set, the spawn goes through the per-user lockfile
   * mutex so two windows never start two daemons.
   */
  async connect(): Promise<RpcClient> {
    if (this.rpc && !this.rpc.isClosed) return this.rpc;
    if (this.opts.singleFlight) return this.connectSingleFlight();
    try {
      return await this.connectSocket();
    } catch (e) {
      this.opts.log?.(`no live sundayd on ${this.opts.socketPath} (${(e as Error).message}); spawning`);
    }
    // Ensure the socket's parent dir exists before the daemon tries to bind
    // (POSIX; harmless no-op attempt on Windows named pipes).
    try {
      fs.mkdirSync(path.dirname(this.opts.socketPath), { recursive: true });
    } catch {
      /* the daemon's stale-recovery also tries */
    }
    let proc: ChildProcess;
    try {
      proc = this.opts.spawnDaemon();
    } catch (e) {
      throw new DaemonSpawnError((e as Error).message);
    }
    this.proc = proc;
    try {
      await this.waitForSocket();
    } catch (e) {
      await this.dispose();
      throw new DaemonSpawnError((e as Error).message);
    }
    try {
      return await this.connectSocket();
    } catch (e) {
      // Spawned fine but the handshake failed (e.g. version skew): still
      // tear down the child we started, but surface the real error.
      await this.dispose();
      throw e;
    }
  }

  getRpc(): RpcClient | undefined {
    return this.rpc;
  }

  /**
   * Phase 8 Stage 2 — single-flight connect. Exactly one daemon per OS user:
   * attach when live, win the lockfile mutex and spawn when free, wait for
   * the winner when contended, steal when stale.
   */
  private async connectSingleFlight(): Promise<RpcClient> {
    const sf = this.opts.singleFlight as SingleFlightOptions;
    const lockPath = sf.lockPath;
    const acquireTimeoutMs = sf.acquireTimeoutMs ?? 15000;
    const pollIntervalMs = sf.pollIntervalMs ?? 100;

    // Fast path: a live daemon may already own the socket.
    try {
      return await this.connectSocket();
    } catch (e) {
      this.opts.log?.(
        `no live sundayd on ${this.opts.socketPath} (${(e as Error).message}); single-flight startup`,
      );
    }

    // Parent dirs for the lockfile and (POSIX) socket, so both the `wx`
    // create and the daemon's bind succeed.
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    } catch {
      /* the daemon's stale-recovery also tries */
    }
    if (process.platform !== 'win32') {
      try {
        fs.mkdirSync(path.dirname(this.opts.socketPath), { recursive: true });
      } catch {
        /* the daemon's stale-recovery also tries */
      }
    }

    const deadline = Date.now() + acquireTimeoutMs;
    for (;;) {
      const claim = {
        pid: process.pid,
        socketPath: this.opts.socketPath,
        startedAt: new Date().toISOString(),
        version: 1 as const,
      };
      if (acquireDaemonLock(lockPath, claim)) {
        this.opts.log?.(`won the sundayd spawn lock ${lockPath}; spawning the shared daemon`);
        return this.spawnSharedDaemon(lockPath);
      }
      const holder = readDaemonLock(lockPath);
      if (!holder || !isPidAlive(holder.pid)) {
        this.opts.log?.(
          `stale sundayd lock ${lockPath} (${holder ? `pid ${holder.pid} is dead` : 'unreadable'}); stealing it`,
        );
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* someone else may have beaten us; loop retries */
        }
        continue;
      }
      // A live process holds the lock — it is spawning (or serving) the
      // daemon. Poll for its socket until the deadline.
      this.opts.log?.(
        `sundayd spawn in progress by pid ${holder.pid}; waiting for the socket`,
      );
      try {
        await this.waitForSocketUntil(deadline, pollIntervalMs);
        return await this.connectSocket();
      } catch (e) {
        throw new DaemonSpawnError(
          `timed out waiting for the sundayd socket (lock held by pid ${holder.pid}): ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * We won the lock: spawn the shared daemon. The child is unref'd and is
   * never killed on dispose — it outlives this window by design. On spawn
   * failure we release our claim so another window can retry.
   */
  private async spawnSharedDaemon(lockPath: string): Promise<RpcClient> {
    let proc: ChildProcess;
    try {
      proc = this.opts.spawnDaemon();
    } catch (e) {
      releaseDaemonLockIfOurs(lockPath, process.pid);
      throw new DaemonSpawnError((e as Error).message);
    }
    this.proc = proc;
    try {
      proc.unref();
    } catch {
      /* ignore */
    }
    try {
      await this.waitForSocket();
    } catch (e) {
      // Never became reachable: best-effort kill of the child we started
      // (no one could have attached yet — the socket never came up),
      // release our claim, surface as a spawn failure.
      try {
        if (proc.exitCode === null) proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = undefined;
      releaseDaemonLockIfOurs(lockPath, process.pid);
      throw new DaemonSpawnError((e as Error).message);
    }
    try {
      // The daemon overwrites the lockfile with its own PID once serving
      // (cli.ts); our claim stays until then as the mutex record.
      return await this.connectSocket();
    } catch (e) {
      // The daemon is up but the handshake failed for us (e.g. version
      // skew). Leave the shared daemon alone — another client may use it —
      // and just detach.
      this.proc = undefined;
      throw e;
    }
  }

  /** Poll until the socket accepts connections, up to an absolute deadline. */
  private async waitForSocketUntil(deadline: number, intervalMs: number): Promise<void> {
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const probe = await openSocket(this.opts.socketPath, 500);
        try {
          probe.destroy();
        } catch {
          /* ignore */
        }
        return;
      } catch (e) {
        lastErr = e;
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
    throw lastErr ?? new Error('timed out waiting for the sundayd socket');
  }

  /** True when this connector spawned (and therefore owns) the daemon. */
  get ownsDaemon(): boolean {
    return this.proc !== undefined;
  }

  /**
   * Best-effort `sunday/shutdown`, then close the socket and terminate the
   * owned child (SIGTERM → SIGKILL fallback). Never throws.
   *
   * Single-flight mode: the daemon is shared, so dispose only detaches —
   * no `sunday/shutdown`, no kill. The daemon's own lifecycle (explicit
   * stop, idle shutdown) owns its teardown.
   */
  async dispose(): Promise<void> {
    const singleFlight = this.opts.singleFlight !== undefined;
    const rpc = this.rpc;
    this.rpc = undefined;
    if (rpc && !rpc.isClosed) {
      if (singleFlight) {
        this.opts.log?.('detaching from the shared sundayd; leaving the daemon running');
      } else {
        try {
          await rpc.request('sunday/shutdown', {}, { timeoutMs: 5000 });
        } catch {
          /* best-effort */
        }
      }
      rpc.close();
    }
    const sock = this.socket;
    this.socket = undefined;
    try {
      sock?.destroy();
    } catch {
      /* ignore */
    }
    const proc = this.proc;
    this.proc = undefined;
    if (proc && !singleFlight && proc.exitCode === null) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      // SIGKILL fallback if it ignores SIGTERM.
      await sleep(2000);
      try {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }

  /** Connect one socket and run the `sunday/hello` handshake over it. */
  private async connectSocket(): Promise<RpcClient> {
    const socket = await openSocket(this.opts.socketPath, this.opts.handshakeTimeoutMs ?? 15000);
    this.socket = socket;
    const rpc = RpcClient.fromSocket(socket);
    this.rpc = rpc;
    try {
      const hello = await this.handshake(rpc);
      this.opts.log?.(
        `sundayd ready over socket — server v${hello.server.version}, protocol v${hello.protocolVersion}`,
      );
      return rpc;
    } catch (e) {
      rpc.close();
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      this.rpc = undefined;
      this.socket = undefined;
      throw e;
    }
  }

  /** Poll until the freshly spawned daemon's socket accepts connections. */
  private async waitForSocket(): Promise<void> {
    const deadline = Date.now() + (this.opts.spawnTimeoutMs ?? 15000);
    let lastErr: unknown;
    while (Date.now() < deadline) {
      // Fail fast when the child died instead of burning the whole timeout.
      if (this.proc && this.proc.exitCode !== null) {
        throw new Error(`sundayd exited during startup (code ${this.proc.exitCode})`);
      }
      try {
        const probe = await openSocket(this.opts.socketPath, 500);
        try {
          probe.destroy();
        } catch {
          /* ignore */
        }
        return;
      } catch (e) {
        lastErr = e;
      }
      await sleep(100);
    }
    throw lastErr ?? new Error('timed out waiting for the sundayd socket');
  }

  /** `sunday/hello` version negotiation (§23). Throws ProtocolMismatchError. */
  private async handshake(rpc: RpcClient): Promise<HelloResult> {
    const raw = await rpc.request(
      'sunday/hello',
      {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: 'sunday-agent', version: this.opts.clientVersion, os: process.platform },
      },
      { timeoutMs: this.opts.handshakeTimeoutMs ?? 15000 },
    );
    const result = helloResultSchema.parse(raw);
    if (!result.negotiated || result.protocolVersion !== PROTOCOL_VERSION) {
      throw new ProtocolMismatchError(
        `client speaks v${PROTOCOL_VERSION}, server answered v${result.protocolVersion} (negotiated=${result.negotiated})`,
      );
    }
    return result;
  }
}
