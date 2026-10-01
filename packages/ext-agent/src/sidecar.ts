// sunday-agent — sundayd sidecar lifecycle: discovery, spawn, handshake,
// crash backoff, clean shutdown (§5.3). Windows-aware process handling.
// This module is vscode-free so it can be unit-tested with plain node.

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROTOCOL_VERSION, helloResultSchema, type HelloResult, ErrorCode } from '@sunday/protocol';
import { RpcClient } from './rpc.js';

/** The sidecar binary/script could not be found anywhere we look. */
export class SidecarNotFoundError extends Error {
  constructor(detail: string) {
    super(`sundayd not found. ${detail}`);
    this.name = 'SidecarNotFoundError';
  }
}

/** spawn() itself failed (ENOENT, EACCES, …). */
export class SidecarStartError extends Error {
  constructor(detail: string) {
    super(`could not start sundayd: ${detail}`);
    this.name = 'SidecarStartError';
  }
}

/** sunday/hello version negotiation failed. */
export class ProtocolMismatchError extends Error {
  readonly code = ErrorCode.ProtocolMismatch;
  constructor(detail: string) {
    super(`protocol mismatch: ${detail}`);
    this.name = 'ProtocolMismatchError';
  }
}

export interface SidecarCommand {
  command: string;
  args: string[];
  /** Where this command came from — shown in logs/errors. */
  source: string;
}

/**
 * Resolve how to launch sundayd. Order:
 *  1. `sunday.sidecar.path` setting (explicit override)
 *  2. bundled next to the built-in extension (`<ext>/sundayd/…`)
 *  3. dev workspace (`<ext>/../sundayd/dist/cli.js`, i.e. packages/sundayd)
 *  4. `sundayd` on PATH
 */
export function resolveSidecarCommand(extensionDir: string, configuredPath?: string): SidecarCommand {
  const trimmed = configuredPath?.trim();
  if (trimmed) {
    // Explicit override: a wrong path is a user error — fail loudly instead
    // of silently falling through to some other sundayd.
    const file = path.resolve(trimmed);
    if (!fs.existsSync(file)) {
      throw new SidecarNotFoundError(`"sunday.sidecar.path" points at ${file}, which does not exist.`);
    }
    return toCommand(file, 'setting "sunday.sidecar.path"');
  }
  const candidates: Array<{ file: string; source: string }> = [
    { file: path.join(extensionDir, 'sundayd', 'sundayd.mjs'), source: 'bundled extension (esbuild)' },
    { file: path.join(extensionDir, 'sundayd', 'dist', 'cli.js'), source: 'bundled extension' },
    { file: path.join(extensionDir, 'sundayd', 'cli.js'), source: 'bundled extension' },
    { file: path.join(extensionDir, '..', 'sundayd', 'dist', 'cli.js'), source: 'workspace (packages/sundayd)' },
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.file)) return toCommand(c.file, c.source);
  }
  const onPath = findOnPath('sundayd');
  if (onPath) return toCommand(onPath, 'PATH');
  const tried = candidates.map((c) => `  - ${c.file} (${c.source})`).join('\n');
  throw new SidecarNotFoundError(
    `Looked in:\n${tried}\n  - sundayd on PATH\n` +
      'Set "sunday.sidecar.path" to the sundayd entrypoint (dist/cli.js), or build @sunday/sundayd.',
  );
}

/** Map a script/binary file to a spawnable command (Windows-aware). */
function toCommand(file: string, source: string): SidecarCommand {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    // Never rely on shebangs/PATHEXT — drive scripts with this node explicitly.
    // Handles paths with spaces on every platform (argv array, no shell).
    return { command: process.execPath, args: [file], source };
  }
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    // .cmd/.bat cannot be spawned directly; go through the command interpreter.
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', file], source };
  }
  return { command: file, args: [], source };
}

function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // PATHEXT on Windows: sundayd may resolve to sundayd.cmd/.exe.
  const suffixes =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((s) => s.toLowerCase())
      : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const full = path.join(dir, name + suffix);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* unreadable dir entry — keep scanning */
      }
    }
  }
  return undefined;
}

export type SidecarStatus = 'stopped' | 'starting' | 'ready' | 'crashed';

export interface SidecarConfig {
  /** Absolute path to the sundayd entrypoint; empty = auto-discover. */
  sidecarPath: string;
}

export interface SidecarManagerOptions {
  /** Extension install dir (contains package.json / dist). */
  extensionDir: string;
  /** sunday-agent version, sent in sunday/hello. */
  clientVersion: string;
  readConfig: () => SidecarConfig;
  log: (msg: string) => void;
  handshakeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** A ready sidecar dying faster than this counts as a rapid crash. */
  crashWindowMs?: number;
  /** Give up auto-restart after this many rapid crashes. */
  maxRapidCrashes?: number;
}

function waitForSpawn(proc: ChildProcess, source: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    proc.once('error', (err: Error) => {
      reject(new SidecarStartError(`${source}: ${(err as NodeJS.ErrnoException).message ?? err}`));
    });
    proc.once('spawn', () => {
      proc.removeAllListeners('error');
      // Re-arm a benign error listener: post-spawn errors (e.g. kill of a
      // dead pid) must not throw unhandled 'error' events.
      proc.on('error', () => undefined);
      resolve();
    });
  });
}

export class SidecarManager {
  private status: SidecarStatus = 'stopped';
  private proc: ChildProcess | undefined;
  private rpcClient: RpcClient | undefined;
  private serverInfo: { name: string; version: string } | undefined;
  private readonly statusListeners = new Set<(s: SidecarStatus) => void>();
  private startPromise: Promise<RpcClient> | undefined;
  private startTime = 0;
  private rapidCrashes = 0;
  private intentionalStop = false;

  constructor(private readonly opts: SidecarManagerOptions) {}

  getStatus(): SidecarStatus {
    return this.status;
  }

  getRpc(): RpcClient | undefined {
    return this.status === 'ready' ? this.rpcClient : undefined;
  }

  getServerInfo(): { name: string; version: string } | undefined {
    return this.serverInfo;
  }

  onDidChangeStatus(listener: (s: SidecarStatus) => void): { dispose(): void } {
    this.statusListeners.add(listener);
    return {
      dispose: () => {
        this.statusListeners.delete(listener);
      },
    };
  }

  /** Start (or await the in-flight start) and run the hello handshake. */
  start(): Promise<RpcClient> {
    // A user-initiated start clears the crash backoff; auto-restarts (which go
    // through startGuarded) must NOT reset it, or the backoff never trips.
    this.rapidCrashes = 0;
    return this.startGuarded();
  }

  private startGuarded(): Promise<RpcClient> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    // Clear the cached promise when it settles so a later start() retries.
    const p = this.startPromise;
    void p.then(
      () => {
        if (this.startPromise === p) this.startPromise = undefined;
      },
      () => {
        if (this.startPromise === p) this.startPromise = undefined;
      },
    );
    return p;
  }

  /** ensureReady is start() with a friendlier name for callers. */
  ensureReady(): Promise<RpcClient> {
    return this.start();
  }

  /** Stop and start again (resets the crash backoff). Serializes with any in-flight start. */
  async restart(): Promise<RpcClient> {
    try {
      await this.start();
    } catch {
      /* ignore — we are restarting anyway */
    }
    await this.stop();
    this.rapidCrashes = 0;
    return this.start();
  }

  /**
   * Clean shutdown: sunday/shutdown RPC first (lets the daemon drain its
   * session persists), then SIGTERM, then SIGKILL as a last resort.
   */
  async stop(): Promise<void> {
    const rpc = this.rpcClient;
    const proc = this.proc;
    this.intentionalStop = true;
    try {
      if (rpc && this.status === 'ready') {
        try {
          await rpc.request('sunday/shutdown', {}, { timeoutMs: this.opts.shutdownTimeoutMs ?? 3000 });
        } catch {
          /* daemon may already be gone — fall through to kill */
        }
      }
      rpc?.close();
      if (proc && proc.exitCode === null && !proc.killed) {
        proc.kill(); // SIGTERM on POSIX, TerminateProcess on Windows
        const deadline = Date.now() + 2000;
        while (proc.exitCode === null && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (proc.exitCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }
      }
    } finally {
      this.proc = undefined;
      this.rpcClient = undefined;
      this.intentionalStop = false;
      this.setStatus('stopped');
    }
  }

  dispose(): void {
    this.statusListeners.clear();
    void this.stop().catch(() => undefined);
  }

  private async doStart(): Promise<RpcClient> {
    this.setStatus('starting');
    let proc: ChildProcess | undefined;
    let rpc: RpcClient | undefined;
    try {
      const cmd = resolveSidecarCommand(this.opts.extensionDir, this.opts.readConfig().sidecarPath || undefined);
      this.opts.log(`spawning sundayd (${cmd.source}): ${cmd.command} ${cmd.args.join(' ')}`);
      proc = spawn(cmd.command, cmd.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, // no console window flash on Windows
        env: { ...process.env },
      });
      // Publish early so stop() can find and kill the child even mid-handshake.
      this.proc = proc;
      this.startTime = Date.now();
      await waitForSpawn(proc, cmd.source);
      rpc = new RpcClient(proc);
      this.rpcClient = rpc;
      rpc.onStderrLine = (line) => this.opts.log(`[sundayd:stderr] ${line}`);
      rpc.onMalformedLine = (line) => this.opts.log(`[sundayd] malformed stdout line: ${line.slice(0, 200)}`);
      proc.on('exit', (code, signal) => this.onProcessExit(code, signal));
      const hello = await this.handshake(rpc);
      this.serverInfo = { ...hello.server };
      this.setStatus('ready');
      this.opts.log(`sundayd ready — server v${hello.server.version}, protocol v${hello.protocolVersion}`);
      return rpc;
    } catch (err) {
      rpc?.close();
      if (proc && proc.exitCode === null) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
      this.proc = undefined;
      this.rpcClient = undefined;
      this.setStatus('stopped');
      throw err;
    }
  }

  /** sunday/hello version negotiation (§23). Throws ProtocolMismatchError. */
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

  private onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasReady = this.status === 'ready';
    this.rpcClient?.close();
    this.proc = undefined;
    this.rpcClient = undefined;
    if (this.intentionalStop || !wasReady) return; // stop() or a failed start owns this
    const windowMs = this.opts.crashWindowMs ?? 5000;
    const maxRapid = this.opts.maxRapidCrashes ?? 3;
    this.rapidCrashes = Date.now() - this.startTime < windowMs ? this.rapidCrashes + 1 : 1;
    if (this.rapidCrashes >= maxRapid) {
      this.setStatus('crashed');
      this.opts.log(
        `sundayd died ${this.rapidCrashes}x in quick succession (code=${code}, signal=${signal}) — ` +
          'auto-restart disabled. Use "Sunday: Restart Sidecar".',
      );
      return;
    }
    this.opts.log(`sundayd exited unexpectedly (code=${code}, signal=${signal}) — restarting…`);
    void this.startGuarded().catch((err: Error) => {
      this.opts.log(`sundayd restart failed: ${err.message}`);
    });
  }

  private setStatus(s: SidecarStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of [...this.statusListeners]) {
      try {
        l(s);
      } catch {
        /* listener errors must not break lifecycle */
      }
    }
  }
}
