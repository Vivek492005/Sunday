// sundayd — inline completion orchestration (Part B).
// Debounce + request coalescing + LRU cache + 1-in-flight-per-document +
// latency instrumentation around the gateway's FIM support.
//
// The extension sends { uri, position, prefix, suffix, docVersion } per
// keystroke; this module never reads files itself. One CompletionOrchestrator
// lives on the Daemon and serves the `completion/complete` RPC.

import { createHash } from 'node:crypto';
import { redactSecrets } from '@sunday/skills';
import type {
  CompletionParams,
  CompletionResult,
  CompletionStats,
} from '@sunday/protocol';
import type { FimRequest, FimResult } from '@sunday/gateway';

export interface CompletionOrchestratorOptions {
  /** Single-shot FIM call (usually a gateway provider's `complete`). */
  complete: (request: FimRequest) => Promise<FimResult>;
  /** Per-document debounce before a keystroke burst hits the provider. */
  debounceMs?: number; // default 75
  /** Max cached entries (LRU). */
  cacheSize?: number; // default 128
  /** Sliding window of latency samples kept for p50/p95. */
  latencyWindow?: number; // default 1000
  /** Emit the sunday.completion.latency metric line every N samples. */
  metricLogInterval?: number; // default 100
  /** Structured-metric sink. Defaults to a JSON line on stderr (the daemon's
   *  diagnostics channel — never parsed as RPC). */
  log?: (line: string) => void;
}

interface PendingRequest {
  timer: ReturnType<typeof setTimeout>;
  resolve: (r: CompletionResult) => void;
  reject: (e: Error) => void;
}

interface InFlightRequest {
  controller: AbortController;
  resolve: (r: CompletionResult) => void;
}

interface CacheEntry {
  completion: string;
  nativeFim: boolean;
}

const CANCELLED: CompletionResult = {
  completion: '',
  cached: false,
  nativeFim: false,
  cancelled: true,
  latencyMs: 0,
};

export class CompletionOrchestrator {
  private readonly completeFn: (request: FimRequest) => Promise<FimResult>;
  private readonly debounceMs: number;
  private readonly cacheSize: number;
  private readonly latencyWindow: number;
  private readonly metricLogInterval: number;
  private readonly log: (line: string) => void;

  /** Debounced-but-not-yet-started requests, keyed by document URI. */
  private readonly pending = new Map<string, PendingRequest>();
  /** Running provider calls, keyed by document URI (max 1 each). */
  private readonly inFlight = new Map<string, InFlightRequest>();
  /** LRU cache keyed by content hash; Map order = recency. */
  private readonly cache = new Map<string, CacheEntry>();

  private cacheHits = 0;
  private cacheMisses = 0;
  private latencies: number[] = [];
  /** Samples recorded since the last sunday.completion.latency log line. */
  private samplesSinceLog = 0;

  constructor(opts: CompletionOrchestratorOptions) {
    this.completeFn = opts.complete;
    this.debounceMs = opts.debounceMs ?? 75;
    this.cacheSize = Math.max(1, opts.cacheSize ?? 128);
    this.latencyWindow = Math.max(1, opts.latencyWindow ?? 1000);
    this.metricLogInterval = Math.max(1, opts.metricLogInterval ?? 100);
    this.log = opts.log ?? ((line) => process.stderr.write(line + '\n'));
  }

  /** Cache key: content hash of (model, docVersion, prefix, suffix).
   *  The docVersion from the extension invalidates the cache on edit. */
  private cacheKey(p: CompletionParams): string {
    return createHash('sha256')
      .update(p.model ?? '')
      .update('\n')
      .update(String(p.docVersion))
      .update('\n')
      .update(p.prefix)
      .update('\n')
      .update(p.suffix ?? '')
      .digest('hex');
  }

  /**
   * Request a completion. Debounced per document; a newer request for the
   * same document supersedes a pending or in-flight one (the older promise
   * resolves with `cancelled: true`). Cache hits resolve immediately.
   */
  complete(params: CompletionParams): Promise<CompletionResult> {
    const key = this.cacheKey(params);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // Refresh LRU recency.
      this.cache.delete(key);
      this.cache.set(key, hit);
      this.cacheHits++;
      return Promise.resolve({
        completion: hit.completion,
        cached: true,
        nativeFim: hit.nativeFim,
        cancelled: false,
        latencyMs: 0,
      });
    }
    this.cacheMisses++;

    this.supersede(params.uri);

    return new Promise<CompletionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(params.uri);
        void this.run(params, key, resolve, reject);
      }, this.debounceMs);
      // A hung daemon must not keep the event loop alive for a keystroke.
      timer.unref?.();
      this.pending.set(params.uri, { timer, resolve, reject });
    });
  }

  /** Cancel any pending/in-flight work for a document (new keystroke won). */
  private supersede(uri: string): void {
    const p = this.pending.get(uri);
    if (p) {
      this.pending.delete(uri);
      clearTimeout(p.timer);
      p.resolve(CANCELLED);
    }
    const f = this.inFlight.get(uri);
    if (f) {
      // run() catches the abort and resolves `cancelled: true` for the owner.
      f.controller.abort();
    }
  }

  private async run(
    params: CompletionParams,
    key: string,
    resolve: (r: CompletionResult) => void,
    reject: (e: Error) => void,
  ): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(params.uri, { controller, resolve });
    const startedAt = Date.now();
    try {
      const fim = await this.completeFn({
        model: params.model ?? '',
        // S6: ghost-text prefix/suffix go to the provider — redact secrets first.
        prefix: redactSecrets(params.prefix),
        suffix: params.suffix ? redactSecrets(params.suffix) : params.suffix,
        maxTokens: params.maxTokens,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      this.recordLatency(latencyMs);
      this.store(key, { completion: fim.completion, nativeFim: fim.nativeFim });
      resolve({
        completion: fim.completion,
        cached: false,
        nativeFim: fim.nativeFim,
        cancelled: false,
        latencyMs,
      });
    } catch (err) {
      if (controller.signal.aborted || (err as Error)?.name === 'AbortError') {
        resolve(CANCELLED);
      } else {
        reject(err as Error);
      }
    } finally {
      if (this.inFlight.get(params.uri)?.controller === controller) {
        this.inFlight.delete(params.uri);
      }
    }
  }

  private store(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.cacheSize) {
      // Map iterates in insertion order: first key is the LRU victim.
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > this.latencyWindow) {
      this.latencies.splice(0, this.latencies.length - this.latencyWindow);
    }
    this.samplesSinceLog++;
    if (this.samplesSinceLog >= this.metricLogInterval) {
      this.samplesSinceLog = 0;
      const s = this.stats();
      this.log(
        JSON.stringify({
          metric: 'sunday.completion.latency',
          ts: new Date().toISOString(),
          count: s.count,
          p50Ms: s.p50Ms,
          p95Ms: s.p95Ms,
          avgMs: s.avgMs,
          cacheHits: s.cacheHits,
          cacheMisses: s.cacheMisses,
        }),
      );
    }
  }

  /** Sliding-window latency stats + cache counters (backs `completion/stats`). */
  stats(): CompletionStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pick = (q: number): number => {
      if (sorted.length === 0) return 0;
      return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    };
    const avg =
      sorted.length === 0 ? 0 : sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return {
      count: sorted.length,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      p50Ms: pick(0.5),
      p95Ms: pick(0.95),
      avgMs: avg,
      inFlight: this.inFlight.size,
    };
  }

  /** Drop all pending/in-flight work and clear the cache. */
  dispose(): void {
    for (const [uri, p] of this.pending) {
      this.pending.delete(uri);
      clearTimeout(p.timer);
      p.resolve(CANCELLED);
    }
    for (const f of this.inFlight.values()) f.controller.abort();
    this.inFlight.clear();
    this.cache.clear();
  }
}
