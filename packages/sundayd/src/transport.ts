import { createInterface } from 'node:readline';
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

/** An application-level failure the daemon wants to surface as a JSON-RPC error. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type RequestHandler = (req: JsonRpcRequest) => Promise<unknown>;

export interface TransportOptions {
  /** What to do when stdin closes (client hung up). Defaults to process.exit(0).
   *  Tests pass a noop so the runner survives. */
  onStdinClose?: () => void;
}

/**
 * NDJSON-over-stdio JSON-RPC transport (§6.3). One JSON object per line on
 * stdin; responses and `chat/event` notifications go to stdout, one per line.
 * Anything diagnostic goes to stderr so it never corrupts the frame stream.
 *
 * Client contract: await each response before sending the next request.
 * Pipelined requests that are still in flight when `sunday/shutdown` lands may
 * not get their responses flushed (process.exit truncates piped stdout);
 * session data itself is always durable — persists are atomic and drained
 * before exit.
 */
export class StdioTransport {
  private started = false;

  constructor(
    private handler: RequestHandler,
    private input: NodeJS.ReadableStream = process.stdin,
    private output: NodeJS.WritableStream = process.stdout,
    private opts: TransportOptions = {},
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const rl = createInterface({ input: this.input, terminal: false });
    rl.on('line', (line) => void this.onLine(line));
    rl.on('close', () => {
      // Client hung up stdin — exit quietly instead of idling forever.
      (this.opts.onStdinClose ?? (() => process.exit(0)))();
    });
  }

  /** Emit a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params: unknown): void {
    this.write(createNotification(method, params));
  }

  private async onLine(line: string): Promise<void> {
    if (!line.trim()) return;
    const parsed = parseMessage(line);
    if (parsed.kind === 'request') {
      const req = parsed.message;
      try {
        const result = await this.handler(req);
        this.write(successResponse(req.id, result));
      } catch (e) {
        this.write(toErrorResponse(req.id, e));
      }
      return;
    }
    if (parsed.kind === 'invalid') {
      // No usable id on an unparseable line; JSON-RPC says id MUST be null here.
      // The protocol type is stricter (string|number), so this is an explicit cast.
      this.write(errorResponse(null as unknown as JsonRpcId, ErrorCode.ParseError, 'invalid JSON-RPC message'));
      return;
    }
    // Notifications / responses inbound are not part of the daemon contract; ignore.
  }

  private write(msg: unknown): void {
    this.output.write(JSON.stringify(msg) + '\n');
  }
}

function toErrorResponse(id: JsonRpcId, e: unknown): ReturnType<typeof errorResponse> {
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
  }
  return errorResponse(id, ErrorCode.InternalError, (e as Error)?.message ?? 'internal error');
}
