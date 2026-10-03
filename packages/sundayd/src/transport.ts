import { createInterface } from 'node:readline';
import { createNotification } from '@sunday/protocol';
import {
  dispatchRequestLine,
  encodeFrame,
  type RequestHandler,
  type ServerTransport,
} from './rpc-transport.js';

// Re-exported for backward compatibility (previously defined here).
export { RpcError } from './rpc-transport.js';
export type { RequestHandler };

export type { ServerTransport };

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
 * Framing and request dispatch are shared with the socket path
 * (`rpc-transport.ts`); only the byte source/sink differs.
 *
 * Client contract: await each response before sending the next request.
 * Pipelined requests that are still in flight when `sunday/shutdown` lands may
 * not get their responses flushed (process.exit truncates piped stdout);
 * session data itself is always durable — persists are atomic and drained
 * before exit.
 */
export class StdioTransport implements ServerTransport {
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
    await dispatchRequestLine(line, this.handler, (msg) => this.write(msg));
  }

  private write(msg: unknown): void {
    this.output.write(encodeFrame(msg));
  }
}
