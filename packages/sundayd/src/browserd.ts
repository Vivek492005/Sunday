// sundayd — browserd child-process lifecycle: discovery, spawn, handshake,
// crash backoff, clean shutdown. Mirrors ext-agent's SidecarManager semantics
// (§5.3) but speaks `browser/ping` instead of `sunday/hello`.
//
// browserd is opt-in: nothing here runs unless the host constructs a
// BrowserdManager and registers the browser_* tools via registerBrowserTools()
// (see browser-tools.ts). The manager spawns the child lazily on first use.

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_METHODS } from '@sunday/protocol';

/** The browserd entrypoint could not be found anywhere we look. */
export class BrowserdNotFoundError extends Error {
  constructor(detail: string) {
    super(`browserd not found. ${detail}`);
    this.name = 'BrowserdNotFoundError';
  }
}

/** spawn() itself failed (ENOENT, EACCES, …). */
export class BrowserdStartError extends Error {
  constructor(detail: string) {
    super(`could not start browserd: ${detail}`);
    this.name = 'BrowserdStartError';
  }
}

/** The child answered with a JSON-RPC error object. */
export class BrowserdRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'BrowserdRpcError';
    this.code = code;
    this.data = data;
  }
}

/** No response arrived within the per-request timeout. */
export class BrowserdTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`browserd request timed out: ${method} (${timeoutMs}ms)`);
    this.name = 'BrowserdTimeoutError';
  }
}

/** The request could not complete because the transport is closed. */
export class BrowserdClosedError extends Error {
  constructor(what = 'browserd transport is closed') {
    super(what);
    this.name = 'BrowserdClosedError';
  }
}

export interface BrowserdCommand {
  command: string;
  args: string[];
  /** Where this command came from — shown in logs/errors. */
  source: string;
}

/**
 * Resolve how to launch browserd. Order:
 *  1. explicit `browserdPath` (config override)
 *  2. next to a bundled sundayd (`<sundayd>/browserd.cjs` — esbuild bundle
 *     shipped inside the extension)
 *  3. sibling workspace package (`<sundayd>/../../browserd/dist/cli.js`,
 *     i.e. packages/browserd — same relative layout in src/ and dist/)
 *  4. `browserd` on PATH (installed bin)
 */
export function resolveBrowserdCommand(
  sundaydModuleDir: string = path.dirname(fileURLToPath(import.meta.url)),
  configuredPath?: string,
): BrowserdCommand {
  const trimmed = configuredPath?.trim();
  if (trimmed) {
    const file = path.resolve(trimmed);
    if (!fs.existsSync(file)) {
      throw new BrowserdNotFoundError(`configured browserd path ${file} does not exist.`);
    }
    return toCommand(file, 'config "browserdPath"');
  }
  const sibling = path.join(sundaydModuleDir, '..', '..', 'browserd', 'dist', 'cli.js');
  const bundled = path.join(sundaydModuleDir, 'browserd.mjs');
  if (fs.existsSync(bundled)) return toCommand(bundled, 'bundled extension (esbuild)');
  if (fs.existsSync(sibling)) return toCommand(sibling, 'workspace (packages/browserd)');
  const onPath = findOnPath('browserd');
  if (onPath) return toCommand(onPath, 'PATH');
  throw new BrowserdNotFoundError(
    `Looked in:\n  - ${sibling} (workspace)\n  - browserd on PATH\n` +
      'Set browserdPath to the browserd entrypoint (packages/browserd/dist/cli.js), or build @sunday/browserd.',
  );
}

/** Map a script/binary file to a spawnable command (Windows-aware). */
function toCommand(file: string, source: string): BrowserdCommand {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    // Never rely on shebangs/PATHEXT — drive scripts with this node explicitly.
    return { command: process.execPath, args: [file], source };
  }
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', file], source };
  }
  return { command: file, args: [], source };
}

function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
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

export type BrowserdStatus = 'stopped' | 'starting' | 'ready' | 'crashed';

export interface BrowserdManagerOptions {
  /** Absolute path to the browserd entrypoint; empty = auto-discover. */
  browserdPath?: string;
  /**
   * Master switch for the browser. Defaults to the SUNDAY_BROWSER_ENABLED
   * env var ('1' = enabled); the browser is off unless opted in.
   */
  browserEnabled?: boolean;
  /** Extra env for the child (merged over process.env). The browserd CLI
   *  reads SUNDAY_WORKSPACE_ROOT, SUNDAY_BROWSER_APPROVED_DOMAINS,
   *  SUNDAY_BROWSER_ALLOW_EVAL, SUNDAY_BROWSER_HEADLESS. */
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  handshakeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** A ready child dying faster than this counts as a rapid crash. */
  crashWindowMs?: number;
  /** Give up auto-restart after this many rapid crashes. */
  maxRapidCrashes?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal NDJSON JSON-RPC client over a child process's stdio. Owns no
 *  process lifecycle — the BrowserdManager spawns/kills. */
class ChildRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;

  constructor(
    private readonly proc: ChildProcess,
    private readonly log: (msg: string) => void,
  ) {
    proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) this.log(`[browserd:stderr] ${line}`);
      }
    });
    proc.on('exit', () => this.close());
    proc.on('error', () => this.close());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new BrowserdClosedError());
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new BrowserdClosedError('browserd stdin is not writable'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserdTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new BrowserdClosedError(`browserd stdin write failed: ${err.message}`));
        }
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BrowserdClosedError());
      this.pending.delete(id);
    }
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`[browserd] malformed stdout line: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.jsonrpc !== '2.0' || (typeof msg.id !== 'number' && typeof msg.id !== 'string')) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new BrowserdRpcError(msg.error.code ?? -32603, msg.error.message ?? 'unknown error', msg.error.data));
    else p.resolve(msg.result);
  }
}

function waitForSpawn(proc: ChildProcess, source: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    proc.once('error', (err: Error) => {
      reject(new BrowserdStartError(`${source}: ${(err as NodeJS.ErrnoException).message ?? err}`));
    });
    proc.once('spawn', () => {
      proc.removeAllListeners('error');
      proc.on('error', () => undefined);
      resolve();
    });
  });
}

export class BrowserdManager {
  private status: BrowserdStatus = 'stopped';
  private proc: ChildProcess | undefined;
  private rpcClient: ChildRpcClient | undefined;
  private driverName: string | undefined;
  private readonly statusListeners = new Set<(s: BrowserdStatus) => void>();
  private startPromise: Promise<ChildRpcClient> | undefined;
  private startTime = 0;
  private rapidCrashes = 0;
  private intentionalStop = false;
  private browserEnabled: boolean;

  constructor(private readonly opts: BrowserdManagerOptions = {}) {
    this.browserEnabled = opts.browserEnabled ?? process.env.SUNDAY_BROWSER_ENABLED === '1';
  }

  /**
   * Master switch for the browser_* tools. Reads SUNDAY_BROWSER_ENABLED='1'
   * at construction (default false); the host (or config) can flip it at
   * runtime via setBrowserEnabled().
   */
  setBrowserEnabled(v: boolean): void {
    this.browserEnabled = v;
  }

  isBrowserEnabled(): boolean {
    return this.browserEnabled;
  }

  getStatus(): BrowserdStatus {
    return this.status;
  }

  /** The driver backend the child reported ("playwright" / "fake"). */
  getDriverName(): string | undefined {
    return this.driverName;
  }

  onDidChangeStatus(listener: (s: BrowserdStatus) => void): { dispose(): void } {
    this.statusListeners.add(listener);
    return {
      dispose: () => {
        this.statusListeners.delete(listener);
      },
    };
  }

  /** Start (or await the in-flight start) and run the ping handshake. */
  start(): Promise<ChildRpcClient> {
    // A user-initiated start clears the crash backoff; auto-restarts (which
    // go through startGuarded) must NOT reset it, or the backoff never trips.
    this.rapidCrashes = 0;
    return this.startGuarded();
  }

  /** ensureReady is start() with a friendlier name for callers. */
  ensureReady(): Promise<ChildRpcClient> {
    return this.start();
  }

  /** Stop and start again (resets the crash backoff). */
  async restart(): Promise<ChildRpcClient> {
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
   * Raw RPC against the child (spawns it first if needed). Used by the
   * browser_* tools. Rejects with BrowserdRpcError / BrowserdTimeoutError /
   * BrowserdClosedError.
   */
  async rpc(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    const client = await this.ensureReady();
    return client.request(method, params, timeoutMs);
  }

  /**
   * Browser Agent UI phase — session controls. These are passthroughs to the
   * browserd child and need it LIVE: unlike rpc() they do NOT lazy-spawn,
   * and throw BrowserdClosedError with a clear message when browserd isn't
   * running.
   */
  private requireLiveClient(): ChildRpcClient {
    const rpc = this.rpcClient;
    if (this.status !== 'ready' || !rpc || rpc.isClosed) {
      throw new BrowserdClosedError('browserd is not running — start the browser before using session controls');
    }
    return rpc;
  }

  /** The user takes over the browser; agent action RPCs are blocked until
   *  releaseControl(). Returns the new control state. */
  async takeover(): Promise<'agent' | 'user'> {
    const r = BROWSER_METHODS['browser/takeover'].result.parse(
      await this.requireLiveClient().request('browser/takeover', {}),
    );
    return r.control;
  }

  /** Hand control back to the agent. Returns the new control state. */
  async releaseControl(): Promise<'agent' | 'user'> {
    const r = BROWSER_METHODS['browser/release'].result.parse(
      await this.requireLiveClient().request('browser/release', {}),
    );
    return r.control;
  }

  /** Who currently drives the browser: 'agent' or 'user'. */
  async controlState(): Promise<'agent' | 'user'> {
    const r = BROWSER_METHODS['browser/control'].result.parse(
      await this.requireLiveClient().request('browser/control', {}),
    );
    return r.control;
  }

  /** Start the live JPEG screencast (frames via browser/frame/latest). */
  async startScreencast(): Promise<void> {
    BROWSER_METHODS['browser/screencast/start'].result.parse(
      await this.requireLiveClient().request('browser/screencast/start', {}),
    );
  }

  /** Stop the live screencast. */
  async stopScreencast(): Promise<void> {
    BROWSER_METHODS['browser/screencast/stop'].result.parse(
      await this.requireLiveClient().request('browser/screencast/stop', {}),
    );
  }

  /** Latest cached screencast frame (base64 JPEG), or null when none yet. */
  async latestFrame(): Promise<string | null> {
    const r = BROWSER_METHODS['browser/frame/latest'].result.parse(
      await this.requireLiveClient().request('browser/frame/latest', {}),
    );
    return r.data;
  }

  /** Start recording into the session media dir. */
  async startRecording(opts: { video?: boolean; trace?: boolean } = {}): Promise<void> {
    BROWSER_METHODS['browser/recording/start'].result.parse(
      await this.requireLiveClient().request('browser/recording/start', opts),
    );
  }

  /** Stop recording; returns the artifact paths under the media dir. */
  async stopRecording(): Promise<{ ok: true; videoPath?: string; tracePath?: string }> {
    const r = BROWSER_METHODS['browser/recording/stop'].result.parse(
      await this.requireLiveClient().request('browser/recording/stop', {}),
    );
    return r;
  }

  /**
   * Clean shutdown: browser/close RPC first (lets the child close the browser
   * profile cleanly), then SIGTERM, then SIGKILL as a last resort.
   */
  async stop(): Promise<void> {
    const rpc = this.rpcClient;
    const proc = this.proc;
    this.intentionalStop = true;
    try {
      if (rpc && this.status === 'ready' && !rpc.isClosed) {
        try {
          await rpc.request('browser/close', {}, this.opts.shutdownTimeoutMs ?? 3000);
        } catch {
          /* child may already be gone — fall through to kill */
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

  private startGuarded(): Promise<ChildRpcClient> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
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

  private log(msg: string): void {
    try {
      this.opts.log?.(msg);
    } catch {
      /* logging must never break lifecycle */
    }
  }

  private async doStart(): Promise<ChildRpcClient> {
    this.setStatus('starting');
    let proc: ChildProcess | undefined;
    let rpc: ChildRpcClient | undefined;
    try {
      const cmd = resolveBrowserdCommand(undefined, this.opts.browserdPath || undefined);
      this.log(`spawning browserd (${cmd.source}): ${cmd.command} ${cmd.args.join(' ')}`);
      proc = spawn(cmd.command, cmd.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.opts.env },
      });
      // Publish early so stop() can find and kill the child even mid-handshake.
      this.proc = proc;
      this.startTime = Date.now();
      await waitForSpawn(proc, cmd.source);
      rpc = new ChildRpcClient(proc, (m) => this.log(m));
      this.rpcClient = rpc;
      proc.on('exit', (code, signal) => this.onProcessExit(code, signal));
      const ping = await rpc.request('browser/ping', {}, this.opts.handshakeTimeoutMs ?? 15_000);
      const parsed = BROWSER_METHODS['browser/ping'].result.parse(ping);
      this.driverName = parsed.driver;
      this.setStatus('ready');
      this.log(`browserd ready — v${parsed.version}, driver=${parsed.driver}`);
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
      this.log(
        `browserd died ${this.rapidCrashes}x in quick succession (code=${code}, signal=${signal}) — ` +
          'auto-restart disabled. Restart the sundayd sidecar to retry.',
      );
      return;
    }
    this.log(`browserd exited unexpectedly (code=${code}, signal=${signal}) — restarting…`);
    void this.startGuarded().catch((err: Error) => {
      this.log(`browserd restart failed: ${err.message}`);
    });
  }

  private setStatus(s: BrowserdStatus): void {
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
