/**
 * Phase 8 Stage 1 — shared NDJSON JSON-RPC transport codec.
 *
 * The NDJSON framing (one JSON object per `\n`-terminated line) is
 * transport-agnostic: it works identically over stdio pipes and over
 * `node:net` sockets (unix sockets / Windows named pipes). This module
 * holds the pieces both paths share:
 *
 * - `encodeFrame` / `NdjsonFramer` — wire encoding and incremental decoding.
 * - `dispatchRequestLine` — server-side handling of one inbound line.
 * - `toErrorResponse` — handler-failure → JSON-RPC error mapping.
 * - `SocketServerTransport` — `ServerTransport` over one `net.Socket`.
 *
 * The stdio path (`StdioTransport` in transport.ts) is re-expressed in terms
 * of these helpers; its public API is unchanged.
 */
import net from 'node:net';
import {
  ErrorCode,
  createNotification,
  errorResponse,
  parseMessage,
  successResponse,
  type JsonRpcId,
  type JsonRpcRequest,
} from '@sunday/protocol';
import { ZodError } from 'zod';

/** Server-side handler for one inbound JSON-RPC request. */
export type RequestHandler = (req: JsonRpcRequest) => Promise<unknown>;

/**
 * Server-side transport surface: receives requests (via `start()`) and
 * emits notifications. Implemented by `StdioTransport` (transport.ts) and
 * `SocketServerTransport` (here).
 */
export interface ServerTransport {
  /** Begin reading inbound frames. Idempotent. */
  start(): void;
  /** Emit a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params: unknown): void;
}

/** Encode one JSON-RPC message as a single NDJSON frame. */
export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + '\n';
}

/**
 * Incremental NDJSON line splitter. Feed arbitrary UTF-8 chunks via `push`;
 * each call returns the complete lines terminated since the last call.
 * A trailing `\r` (CRLF writers) is stripped per line.
 */
export class NdjsonFramer {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      lines.push(this.buffer.slice(0, idx).replace(/\r$/, ''));
      this.buffer = this.buffer.slice(idx + 1);
    }
    return lines;
  }
}

/**
 * Map a request-handler failure to a JSON-RPC error response object.
 * Shared by the stdio and socket server paths so error semantics are
 * identical on both transports.
 */
export function toErrorResponse(id: JsonRpcId, e: unknown): ReturnType<typeof errorResponse> {
  if (e instanceof RpcError) return errorResponse(id, e.code, e.message, e.data);
  if (e instanceof ZodError) {
    return errorResponse(id, ErrorCode.InvalidParams, `invalid params: ${e.issues.map((i) => i.message).join('; ')}`);
  }
  // Phase 5: orchestration-layer errors. Matched structurally (by name, not by
  // import) so sundayd keeps its one-directional package edge — the
  // orchestrator's OrchestrationError carries a stable `code` for exactly
  // this mapping. Input-shaped failures → InvalidParams; anything else stays
  // an internal error.
  if (e instanceof Error && e.name === 'OrchestrationError') {
    const code = (e as { code?: string }).code;
    if (code === 'invalid-params' || code === 'plan-invalid' || code === 'too-many-units' || code === 'plan-overlap') {
      return errorResponse(id, ErrorCode.InvalidParams, e.message);
    }
    // Parallel Agents phase: unknown runId → application-level 404.
    if (code === 'unknown-run') {
      return errorResponse(id, ErrorCode.RunNotFound, e.message);
    }
  }
  return errorResponse(id, ErrorCode.InternalError, (e as Error)?.message ?? 'internal error');
}

/**
 * Server-side dispatch of a single NDJSON line. Requests run through
 * `handler` and the response is passed to `write`; unparseable lines get a
 * ParseError (id null, per JSON-RPC); inbound notifications/responses are
 * not part of the daemon contract and are ignored.
 */
export async function dispatchRequestLine(
  line: string,
  handler: RequestHandler,
  write: (msg: unknown) => void,
): Promise<void> {
  const parsed = parseMessage(line);
  if (parsed.kind === 'request') {
    const req = parsed.message;
    try {
      const result = await handler(req);
      write(successResponse(req.id, result));
    } catch (e) {
      write(toErrorResponse(req.id, e));
    }
    return;
  }
  if (parsed.kind === 'invalid') {
    // No usable id on an unparseable line; JSON-RPC says id MUST be null here.
    // The protocol type is stricter (string|number), so this is an explicit cast.
    write(errorResponse(null as unknown as JsonRpcId, ErrorCode.ParseError, 'invalid JSON-RPC message'));
    return;
  }
  // Notifications / responses inbound are not part of the daemon contract; ignore.
}

/**
 * An application-level failure the daemon wants to surface as a JSON-RPC error.
 * (Moved here from transport.ts so both server transports share the mapping.)
 */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/**
 * Server-side JSON-RPC transport over one `node:net` socket (unix domain
 * socket on POSIX, named pipe on Windows — the same `net.Socket` API covers
 * both). One instance per accepted connection; the request handler is
 * typically `daemon.handleRequest` so many connections can share one daemon.
 *
 * Framing, dispatch, and error semantics are identical to the stdio path.
 */
export class SocketServerTransport implements ServerTransport {
  private readonly framer = new NdjsonFramer();
  private started = false;
  private closed = false;

  constructor(
    private readonly socket: net.Socket,
    private readonly handler: RequestHandler,
    private readonly opts: { onClose?: () => void } = {},
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.socket.on('data', (chunk: Buffer) => {
      for (const line of this.framer.push(chunk.toString('utf8'))) {
        if (!line.trim()) continue;
        void dispatchRequestLine(line, this.handler, (msg) => this.write(msg));
      }
    });
    // 'error' always precedes 'close' for a dead peer; swallow it here so a
    // client hangup never throws unhandled — cleanup happens on 'close'.
    this.socket.on('error', () => undefined);
    this.socket.on('close', () => this.close());
  }

  notify(method: string, params: unknown): void {
    this.write(createNotification(method, params));
  }

  private write(msg: unknown): void {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(encodeFrame(msg));
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.opts.onClose?.();
    } catch {
      /* cleanup callbacks must never throw */
    }
  }
}
