/**
 * @sunday/hosted-gateway — per-key token-bucket rate limiting.
 *
 * Two independent buckets per API key:
 *  - requests per minute (request count — stops hot loops)
 *  - tokens per minute (estimated input tokens — stops budget burn)
 *
 * Both must have capacity for a request to be admitted. Buckets refill
 * continuously. Memory-bounded: idle buckets are evicted lazily.
 */

export interface BucketSpec {
  /** Bucket capacity. */
  capacity: number;
  /** Refill rate per millisecond. */
  refillPerMs: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** ms until enough capacity for a minimal request; 0 when allowed. */
  retryAfterMs: number;
  /** Bucket snapshot for response headers. */
  remainingRequests: number;
  remainingTokens: number;
}

const EVICT_AFTER_MS = 10 * 60_000;

export class KeyRateLimiter {
  private readonly buckets = new Map<string, { req: BucketState; tok: BucketState }>();
  private readonly reqSpec: BucketSpec;
  private readonly tokSpec: BucketSpec;
  private readonly now: () => number;

  constructor(opts: {
    requestsPerMinute: number;
    tokensPerMinute: number;
    now?: () => number;
  }) {
    this.reqSpec = {
      capacity: opts.requestsPerMinute,
      refillPerMs: opts.requestsPerMinute / 60_000,
    };
    this.tokSpec = {
      capacity: opts.tokensPerMinute,
      refillPerMs: opts.tokensPerMinute / 60_000,
    };
    this.now = opts.now ?? Date.now;
  }

  private refill(s: BucketState, spec: BucketSpec, now: number): void {
    const elapsed = now - s.lastRefillMs;
    if (elapsed > 0) {
      s.tokens = Math.min(spec.capacity, s.tokens + elapsed * spec.refillPerMs);
      s.lastRefillMs = now;
    }
  }

  private stateFor(keyId: string, now: number): { req: BucketState; tok: BucketState } {
    let s = this.buckets.get(keyId);
    if (!s) {
      s = {
        req: { tokens: this.reqSpec.capacity, lastRefillMs: now, lastSeenMs: now },
        tok: { tokens: this.tokSpec.capacity, lastRefillMs: now, lastSeenMs: now },
      };
      this.buckets.set(keyId, s);
    }
    return s;
  }

  /**
   * Try to admit a request costing 1 request-unit and `tokenCost`
   * estimated input tokens. On success both buckets are debited.
   */
  tryAdmit(keyId: string, tokenCost: number): RateLimitDecision {
    const now = this.now();
    // Lazy eviction of long-idle buckets (bounded memory).
    for (const [id, s] of this.buckets) {
      if (id !== keyId && now - s.req.lastSeenMs > EVICT_AFTER_MS) {
        this.buckets.delete(id);
      }
    }
    const s = this.stateFor(keyId, now);
    this.refill(s.req, this.reqSpec, now);
    this.refill(s.tok, this.tokSpec, now);
    s.req.lastSeenMs = now;
    s.tok.lastSeenMs = now;

    const okReq = s.req.tokens >= 1;
    const okTok = s.tok.tokens >= tokenCost;
    if (okReq && okTok) {
      s.req.tokens -= 1;
      s.tok.tokens -= tokenCost;
      return {
        allowed: true,
        retryAfterMs: 0,
        remainingRequests: Math.floor(s.req.tokens),
        remainingTokens: Math.floor(s.tok.tokens),
      };
    }

    // Time until the scarcest bucket can cover the cost.
    let waitMs = 0;
    if (!okReq) waitMs = Math.max(waitMs, (1 - s.req.tokens) / this.reqSpec.refillPerMs);
    if (!okTok) waitMs = Math.max(waitMs, (tokenCost - s.tok.tokens) / this.tokSpec.refillPerMs);
    return {
      allowed: false,
      retryAfterMs: Math.ceil(waitMs),
      remainingRequests: Math.floor(s.req.tokens),
      remainingTokens: Math.floor(s.tok.tokens),
    };
  }

  /** Number of tracked keys (for tests/health). */
  size(): number {
    return this.buckets.size;
  }
}

/** Rough input-token estimate for abuse-control purposes (chars/4). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
