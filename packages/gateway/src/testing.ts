import { ProviderHttpError } from './openai-compatible.js';
import type { ChatChunk, ChatProvider, ChatRequest, ModelEntry } from './types.js';

/** Test-only provider double: plays canned scripts per chat() call, or fails
 *  with a forced HTTP-style error — no network, no API keys. Not for
 *  production use. */

export interface MockChatProviderOptions {
  id?: string;
  label?: string;
  /** Canned scripts: one array of chunks per chat() call (FIFO). */
  scripts?: ChatChunk[][];
  /** When true, chat() throws a 429 ProviderHttpError without network. */
  force429?: boolean;
  /** Force a different HTTP status instead of 429 (e.g. 500, 503). */
  forceStatus?: number;
  /** Value for the Retry-After header on forced errors (seconds). */
  retryAfterSec?: number;
  models?: ModelEntry[];
}

const DEFAULT_MODEL: ModelEntry = {
  id: 'mock-model',
  label: 'Mock Model',
  contextWindow: 8192,
  supportsTools: true,
};

export class MockChatProvider implements ChatProvider {
  readonly id: string;
  readonly label: string;
  private readonly queue: ChatChunk[][];
  private readonly forceStatus: number | undefined;
  private readonly retryAfterSec: number | undefined;
  private readonly models: ModelEntry[];

  constructor(opts: MockChatProviderOptions = {}) {
    this.id = opts.id ?? 'mock';
    this.label = opts.label ?? 'Mock provider';
    this.queue = (opts.scripts ?? []).map((s) => [...s]);
    this.forceStatus = opts.force429 ? 429 : opts.forceStatus;
    this.retryAfterSec = opts.retryAfterSec;
    this.models = opts.models ?? [DEFAULT_MODEL];
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    if (this.forceStatus !== undefined) {
      const headers = new Headers();
      if (this.retryAfterSec !== undefined) {
        headers.set('retry-after', String(this.retryAfterSec));
      }
      throw new ProviderHttpError(
        this.forceStatus,
        `forced HTTP ${this.forceStatus} (test double)`,
        headers,
      );
    }
    const script = this.queue.shift() ?? [{ type: 'done', finishReason: 'stop' } as ChatChunk];
    for (const c of script) {
      if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      yield c;
    }
  }

  async listModels(): Promise<ModelEntry[]> {
    return this.models;
  }
}
