// sunday-agent — NDJSON JSON-RPC 2.0 client over the sundayd child-process
// stdio (§23.1). One JSON object per line; stdout carries responses +
// notifications, stderr is diagnostics (forwarded, never parsed).

import type { ChildProcess } from 'node:child_process';
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
 * Minimal JSON-RPC client. Owns no process lifecycle — the SidecarManager
 * spawns/kills; this class only frames bytes and correlates ids.
 */
export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<string | number, Pending>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;

  /** Called for stdout lines that are not valid JSON-RPC (never throws). */
  onMalformedLine: (line: string) => void = () => undefined;
  /** stderr is diagnostics — one call per line, never parsed as RPC. */
  onStderrLine: (line: string) => void = () => undefined;

  constructor(private readonly proc: ChildProcess) {
    proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
    proc.on('exit', () => this.close());
    proc.on('error', () => this.close());
  }

  /** Is the underlying transport still usable? */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a request and resolve with `result` (rejects on error/timeout/close). */
  request(method: string, params: unknown = {}, opts: RequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcClosedError());
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new RpcClosedError('sundayd stdin is not writable'));
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
      stdin.write(line + '\n', (err) => {
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
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new RpcClosedError('sundayd stdin is not writable');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
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
