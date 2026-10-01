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
import { BrowserPolicyError } from './policy.js';
import { DriverError } from './driver.js';

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export interface TransportOptions {
  onStdinClose?: () => void;
}

/**
 * NDJSON-over-stdio JSON-RPC transport for browserd. Same framing contract
 * as sundayd's StdioTransport (§6.3): one JSON object per line on stdin,
 * responses on stdout, diagnostics on stderr. browserd speaks only the
 * `browser/*` methods, so the handler takes a bare method name.
 */
export class BrowserTransport {
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
      (this.opts.onStdinClose ?? (() => process.exit(0)))();
    });
  }

  notify(method: string, params: unknown): void {
    this.write(createNotification(method, params));
  }

  private async onLine(line: string): Promise<void> {
    if (!line.trim()) return;
    const parsed = parseMessage(line);
    if (parsed.kind === 'request') {
      const req = parsed.message;
      try {
        const result = await this.handler(req.method, req.params);
        this.write(successResponse(req.id, result));
      } catch (e) {
        this.write(toErrorResponse(req.id, e));
      }
      return;
    }
    if (parsed.kind === 'invalid') {
      this.write(errorResponse(null as unknown as JsonRpcId, ErrorCode.ParseError, 'invalid JSON-RPC message'));
      return;
    }
    // Notifications / responses inbound are not part of the contract; ignore.
  }

  private write(msg: unknown): void {
    this.output.write(JSON.stringify(msg) + '\n');
  }
}

/** Application-level failure the server wants as a JSON-RPC error. */
export class BrowserRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function toErrorResponse(id: JsonRpcId, e: unknown): ReturnType<typeof errorResponse> {
  if (e instanceof BrowserRpcError) return errorResponse(id, e.code, e.message, e.data);
  if (e instanceof BrowserPolicyError) return errorResponse(id, ErrorCode.PolicyDenied, e.message);
  if (e instanceof DriverError) return errorResponse(id, ErrorCode.InternalError, e.message);
  if (e instanceof ZodError) {
    return errorResponse(id, ErrorCode.InvalidParams, `invalid params: ${e.issues.map((i) => i.message).join('; ')}`);
  }
  if (e instanceof Error && typeof (e as { code?: unknown }).code === 'number') {
    // An error that already carries a JSON-RPC code — pass it through.
    const ce = e as Error & { code: number };
    return errorResponse(id, ce.code, ce.message);
  }
  return errorResponse(id, ErrorCode.InternalError, (e as Error)?.message ?? 'internal error');
}

// Keep the request type import used (mirrors sundayd's transport signature).
export type { JsonRpcRequest };
