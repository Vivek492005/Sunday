/**
 * Phase 8 Stage 1 — DaemonConnector: connect the extension to sundayd over a
 * socket, spawning `sundayd --socket <path>` when nothing is listening.
 *
 * Same topology as today (one daemon per window); the single-flight per-user
 * daemon arrives in Stage 2. The connector owns the child it spawns and
 * shuts it down on dispose, mirroring SidecarManager semantics
 * (`sunday/shutdown` → SIGTERM → SIGKILL fallback). When it attaches to an
 * already-listening daemon it owns nothing and only closes its own socket.
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
import { PROTOCOL_VERSION, helloResultSchema, type HelloResult } from '@sunday/protocol';
import { RpcClient } from './rpc.js';

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
   */
  async connect(): Promise<RpcClient> {
    if (this.rpc && !this.rpc.isClosed) return this.rpc;
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

  /** True when this connector spawned (and therefore owns) the daemon. */
  get ownsDaemon(): boolean {
    return this.proc !== undefined;
  }

  /**
   * Best-effort `sunday/shutdown`, then close the socket and terminate the
   * owned child (SIGTERM → SIGKILL fallback). Never throws.
   */
  async dispose(): Promise<void> {
    const rpc = this.rpc;
    this.rpc = undefined;
    if (rpc && !rpc.isClosed) {
      try {
        await rpc.request('sunday/shutdown', {}, { timeoutMs: 5000 });
      } catch {
        /* best-effort */
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
    if (proc && proc.exitCode === null) {
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
