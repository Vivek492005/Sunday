// sunday-agent — NDJSON JSON-RPC 2.0 client over the sundayd sidecar.
//
// Phase 8 Stage 1: two transports, one framing. The classic path is the
// child-process stdio (§23.1); `--socket` mode speaks the same NDJSON frames
// over a `node:net` socket (unix socket / Windows named pipe). Both go
// through the same `RpcWire` byte interface below.

import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import { parseMessage } from '@sunday/protocol';

/** Server answered with a JSON-RPC error object. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** No response arrived within the per-request timeout. */
export class RpcTimeoutError extends Error {
  readonly method: string;
  constructor(method: string, timeoutMs: number) {
    super(`sundayd request timed out: ${method} (${timeoutMs}ms)`);
    this.name = 'RpcTimeoutError';
    this.method = method;
  }
}

/** The request could not complete because the transport is closed. */
export class RpcClosedError extends Error {
  constructor(what = 'sundayd transport is closed') {
    super(what);
    this.name = 'RpcClosedError';
  }
}

export interface RequestOptions {
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type NotificationHandler = (params: unknown) => void;

/**
 * Phase 8 Stage 1: byte-level transport behind `RpcClient`. The stdio path
 * adapts a `ChildProcess` (stdout = frames, stderr = diagnostics, stdin =
 * writes); the socket path adapts a `net.Socket` (frames both ways, no
 * diagnostics channel).
 */
export interface RpcWire {
  /** Inbound NDJSON frame bytes. */
  onData(cb: (chunk: Buffer) => void): void;
  /** Diagnostic bytes (stderr). Never parsed as RPC; no-op on sockets. */
  onDiagnostic(cb: (chunk: Buffer) => void): void;
  /** The peer went away (process exit / socket close / error). */
  onTerminated(cb: () => void): void;
  /** Write one `\n`-terminated frame. */
  writeLine(line: string, cb: (err?: Error | null | undefined) => void): void;
  /** False once the write side is gone. */
  isWritable(): boolean;
}

function childProcessWire(proc: ChildProcess): RpcWire {
  return {
    onData: (cb) => proc.stdout?.on('data', cb),
    onDiagnostic: (cb) => proc.stderr?.on('data', cb),
    onTerminated: (cb) => {
      proc.on('exit', cb);
      proc.on('error', cb);
    },
    writeLine: (line, cb) => {
      const stdin = proc.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        cb(new Error('sundayd stdin is not writable'));
        return;
      }
      stdin.write(line + '\n', cb);
    },
    isWritable: () => {
      const stdin = proc.stdin;
      return !!stdin && !stdin.destroyed && stdin.writable;
    },
  };
}

function socketWire(socket: Socket): RpcWire {
  return {
    onData: (cb) => socket.on('data', cb),
    onDiagnostic: () => undefined,
    onTerminated: (cb) => {
      socket.on('close', cb);
      // 'error' precedes 'close' on a dead peer; the close handler owns
      // teardown, this just prevents an unhandled 'error' throw.
      socket.on('error', () => undefined);
    },
    writeLine: (line, cb) => {
      if (socket.destroyed || !socket.writable) {
        cb(new Error('sundayd socket is not writable'));
        return;
      }
      socket.write(line + '\n', cb);
    },
    isWritable: () => !socket.destroyed && socket.writable,
  };
}

/** Distinguish `new RpcClient(childProc)` from `new RpcClient(wire)`. */
function isChildProcess(v: ChildProcess | RpcWire): v is ChildProcess {
  return (
    typeof (v as ChildProcess).stdin !== 'undefined' ||
    typeof (v as ChildProcess).stdout !== 'undefined'
  );
}

/**
 * Minimal JSON-RPC client. Owns no process lifecycle — the SidecarManager
 * spawns/kills; this class only frames bytes and correlates ids.
 *
 * Phase 8 Stage 1: construct from a child process (`new RpcClient(proc)`,
 * stdio) or from a connected socket (`RpcClient.fromSocket(socket)`).
 */
export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<string | number, Pending>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly wire: RpcWire;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;

  /** Called for stdout lines that are not valid JSON-RPC (never throws). */
  onMalformedLine: (line: string) => void = () => undefined;
  /** stderr is diagnostics — one call per line, never parsed as RPC. */
  onStderrLine: (line: string) => void = () => undefined;

  constructor(proc: ChildProcess);
  constructor(wire: RpcWire);
  constructor(procOrWire: ChildProcess | RpcWire) {
    this.wire = isChildProcess(procOrWire) ? childProcessWire(procOrWire) : procOrWire;
    this.wire.onData((chunk: Buffer) => this.onStdout(chunk));
    this.wire.onDiagnostic((chunk: Buffer) => this.onStderr(chunk));
    this.wire.onTerminated(() => this.close());
  }

  /**
   * Phase 8 Stage 1: build a client over an already-connected `net.Socket`
   * (unix socket / Windows named pipe). The caller owns the socket lifecycle;
   * `close()` here only tears down RPC state, mirroring the stdio contract
   * ("does NOT kill the process").
   */
  static fromSocket(socket: Socket): RpcClient {
    return new RpcClient(socketWire(socket));
  }

  /** Is the underlying transport still usable? */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a request and resolve with `result` (rejects on error/timeout/close). */
  request(method: string, params: unknown = {}, opts: RequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcClosedError());
    if (!this.wire.isWritable()) {
      return Promise.reject(new RpcClosedError('sundayd transport is not writable'));
    }
    const timeoutMs = opts.timeoutMs ?? 30000;
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      // Don't hold the event loop hostage on a hung daemon.
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.wire.writeLine(line, (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.reject(new RpcClosedError(`write failed: ${err.message}`));
          }
        }
      });
    });
  }

  /** Fire-and-forget notification (no id, no response). */
  notify(method: string, params: unknown = {}): void {
    if (this.closed) throw new RpcClosedError();
    if (!this.wire.isWritable()) throw new RpcClosedError('sundayd transport is not writable');
    // Fire-and-forget: async write failures are unobserved, matching the
    // original stdio behaviour.
    this.wire.writeLine(JSON.stringify({ jsonrpc: '2.0', method, params }), () => undefined);
  }

  /** Subscribe to a server→client notification method. Returns an unsubscribe fn. */
  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.notificationHandlers.delete(method);
    };
  }

  /**
   * Shut the transport down: reject every in-flight request, drop handlers.
   * Does NOT kill the process — that belongs to the SidecarManager.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcClosedError());
    }
    this.pending.clear();
    this.notificationHandlers.clear();
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (line.length === 0) continue;
      this.dispatchLine(line);
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, idx).replace(/\r$/, '');
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          this.onStderrLine(line);
        } catch {
          /* diagnostics must never break the transport */
        }
      }
    }
  }

  private dispatchLine(line: string): void {
    const parsed = parseMessage(line);
    if (parsed.kind === 'invalid') {
      try {
        this.onMalformedLine(line);
      } catch {
        /* ignore */
      }
      return;
    }
    if (parsed.kind === 'response') {
      const p = this.pending.get(parsed.message.id);
      if (!p) return; // late response after a timeout — drop it
      this.pending.delete(parsed.message.id);
      clearTimeout(p.timer);
      if ('error' in parsed.message && parsed.message.error !== undefined) {
        const e = parsed.message.error;
        p.reject(new RpcError(e.code, e.message, e.data));
      } else {
        p.resolve((parsed.message as { result?: unknown }).result);
      }
      return;
    }
    if (parsed.kind === 'notification') {
      const handlers = this.notificationHandlers.get(parsed.message.method);
      if (!handlers) return;
      for (const h of [...handlers]) {
        try {
          h(parsed.message.params);
        } catch {
          /* one bad handler must not break dispatch */
        }
      }
      return;
    }
    // kind === 'request': sundayd never sends requests to the client in the
    // Phase-1 protocol (host.* reverse calls arrive later). Ignore defensively.
  }
}
