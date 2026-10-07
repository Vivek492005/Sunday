/**
 * @sunday/cli — DaemonClient: minimal JSON-RPC client for the per-user
 * sundayd daemon (Phase 8 CLI frontend).
 *
 * Reuses the wire protocol from `@sunday/protocol` (paths, lockfile,
 * handshake schemas, method schemas) and the NDJSON codec from
 * `@sunday/sundayd`. Transport is a unix socket (POSIX) or named pipe
 * (Windows), same framing as the VS Code extension's socket mode.
 *
 * Connection is single-flight: attach to the live per-user daemon when
 * present, otherwise arbitrate the spawn mutex and start one detached.
 */
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  PROTOCOL_VERSION,
  helloResultSchema,
  parseMessage,
  sharedDaemonSocketPath,
  sharedDaemonLockPath,
  acquireDaemonLock,
  readDaemonLock,
  isPidAlive,
  type DaemonLockInfo,
} from '@sunday/protocol';
import { NdjsonFramer, encodeFrame } from '@sunday/sundayd';

export const CLI_VERSION = '1.0.0-beta.1';
export const CLI_NAME = 'sunday-cli';

export class DaemonClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonClientError';
  }
}

export class DaemonSpawnError extends DaemonClientError {
  constructor(detail: string) {
    super(`could not start sundayd: ${detail}`);
    this.name = 'DaemonSpawnError';
  }
}

export class ProtocolMismatchError extends DaemonClientError {
  constructor(detail: string) {
    super(detail);
    this.name = 'ProtocolMismatchError';
  }
}

export type NotificationHandler = (params: unknown) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve the sundayd CLI entrypoint from the installed workspace package. */
export function resolveSundaydCli(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('@sunday/sundayd/package.json');
  return path.join(path.dirname(pkgPath), 'dist', 'cli.js');
}

export interface DaemonClientOptions {
  socketPath?: string;
  lockPath?: string;
  /** Spawn `sundayd --socket`. Defaults to a detached `node <sundayd>/dist/cli.js`. */
  spawnDaemon?: (socketPath: string) => ChildProcess;
  handshakeTimeoutMs?: number;
  spawnTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class DaemonClient {
  private socket: net.Socket | null = null;
  private framer = new NdjsonFramer();
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private closed = false;

  constructor(private readonly opts: DaemonClientOptions = {}) {}

  get isClosed(): boolean {
    return this.closed;
  }

  private log(msg: string): void {
    this.opts.log?.(`[sunday] ${msg}`);
  }

  private get socketPath(): string {
    return this.opts.socketPath ?? sharedDaemonSocketPath();
  }

  private get lockPath(): string {
    return this.opts.lockPath ?? sharedDaemonLockPath();
  }

  /** Connect: attach to the live per-user daemon or spawn one (single-flight). */
  async connect(): Promise<void> {
    const socketPath = this.socketPath;
    // 1. Try to attach.
    const existing = await this.tryOpen(socketPath, 2000).catch(() => null);
    if (existing) {
      this.attachSocket(existing);
      this.log(`attached to running daemon at ${socketPath}`);
      await this.hello();
      return;
    }
    // 2. Arbitrate the spawn mutex (ensure the dir exists first — the
    //    lockfile helper throws on missing parents by contract).
    const lockPath = this.lockPath;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const me: DaemonLockInfo = {
      pid: process.pid,
      socketPath,
      startedAt: new Date().toISOString(),
      version: 1,
    };
    if (acquireDaemonLock(lockPath, me)) {
      this.log('won spawn mutex, starting sundayd');
      this.spawnDaemon(socketPath);
      const sock = await this.waitForSocket(socketPath, this.opts.spawnTimeoutMs ?? 15000);
      this.attachSocket(sock);
      await this.hello();
      return;
    }
    // 3. Someone else holds the lock — wait for their socket, or steal a stale lock.
    const deadline = Date.now() + (this.opts.spawnTimeoutMs ?? 15000);
    for (;;) {
      const lock = readDaemonLock(lockPath);
      if (!lock || !isPidAlive(lock.pid)) {
        // Stale or unreadable lock — steal it and retry.
        this.log('stale lock detected, retrying spawn');
        try {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(lockPath);
        } catch {
          /* best-effort */
        }
        return this.connect();
      }
      const sock = await this.tryOpen(socketPath, 500).catch(() => null);
      if (sock) {
        this.attachSocket(sock);
        this.log(`attached to daemon spawned by pid ${lock.pid}`);
        await this.hello();
        return;
      }
      if (Date.now() > deadline) {
        throw new DaemonSpawnError(`timed out waiting for daemon socket at ${socketPath}`);
      }
      await sleep(100);
    }
  }

  private tryOpen(socketPath: string, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new DaemonClientError(`connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      sock.once('connect', () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private spawnDaemon(socketPath: string): void {
    const spawnFn =
      this.opts.spawnDaemon ??
      ((sp: string) => {
        const cli = resolveSundaydCli();
        return spawn(process.execPath, [cli, '--socket', sp], {
          detached: true,
          stdio: 'ignore',
        });
      });
    const child = spawnFn(socketPath);
    child.unref?.();
    this.log(`spawned sundayd (pid ${child.pid})`);
  }

  private async waitForSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sock = await this.tryOpen(socketPath, 500).catch(() => null);
      if (sock) return sock;
      if (Date.now() > deadline) {
        throw new DaemonSpawnError(`sundayd did not listen on ${socketPath} in time`);
      }
      await sleep(100);
    }
  }

  private attachSocket(sock: net.Socket): void {
    this.socket = sock;
    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('error', () => this.close());
    sock.on('close', () => this.close());
  }

  private async hello(): Promise<void> {
    const params = {
      protocolVersion: PROTOCOL_VERSION,
      client: { name: CLI_NAME, version: CLI_VERSION, os: process.platform },
    };
    const result = await this.request('sunday/hello', params, { timeoutMs: this.opts.handshakeTimeoutMs ?? 15000 });
    const parsed = helloResultSchema.safeParse(result);
    if (!parsed.success) throw new ProtocolMismatchError('bad sunday/hello response');
    if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
      throw new ProtocolMismatchError(
        `protocol mismatch: daemon speaks ${parsed.data.protocolVersion}, CLI speaks ${PROTOCOL_VERSION}`,
      );
    }
    this.log(`handshake ok (protocol v${parsed.data.protocolVersion})`);
  }

  /** Send a JSON-RPC request; resolves with `result`. */
  request(method: string, params: unknown = {}, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.closed || !this.socket) return Promise.reject(new DaemonClientError('not connected'));
    const timeoutMs = opts.timeoutMs ?? 60000;
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonClientError(`request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(encodeFrame({ jsonrpc: '2.0', id, method, params }), (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.reject(new DaemonClientError(`write failed: ${err.message}`));
          }
        }
      });
    });
  }

  /** Subscribe to a server→client notification. Returns an unsubscribe fn. */
  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  private onData(chunk: Buffer): void {
    for (const line of this.framer.push(chunk.toString('utf8'))) {
      const parsed = parseMessage(line);
      if (parsed.kind === 'response') {
        const p = this.pending.get(parsed.message.id as number);
        if (!p) continue;
        this.pending.delete(parsed.message.id as number);
        clearTimeout(p.timer);
        if ('error' in parsed.message && parsed.message.error) {
          p.reject(new DaemonClientError(parsed.message.error.message ?? 'RPC error'));
        } else {
          p.resolve(parsed.message.result);
        }
      } else if (parsed.kind === 'notification') {
        const handlers = this.notificationHandlers.get(parsed.message.method);
        if (handlers) {
          for (const h of handlers) {
            try {
              h(parsed.message.params);
            } catch {
              /* handler errors must not break the pump */
            }
          }
        }
      }
      // 'request' (never served by the CLI) and 'invalid' lines are ignored.
    }
  }

  /** Detach from the daemon. Never shuts it down (shared per-user daemon). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DaemonClientError('client closed'));
    }
    this.pending.clear();
    try {
      this.socket?.destroy();
    } catch {
      /* best-effort */
    }
    this.socket = null;
  }
}
