/** Rate-limit scheduler (§10.5, Phase 3): per provider+model sliding-window
 *  limiting plus 429 cooldown tracking. The clock is injectable (`now`) so
 *  tests can use fake time deterministically. */

export interface RateLimitConfig {
  /** Max requests allowed inside one sliding window. */
  maxRequests: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { maxRequests: 60, windowMs: 60_000 };

export type AcquireResult = { ok: true } | { ok: false; retryAfterMs: number };

/** Parse a `Retry-After` value into milliseconds. Supports:
 *  - `Retry-After: <seconds>` (integer; the standard form)
 *  - `Retry-After: <HTTP-date>`
 *  - millisecond variants some providers send: `Retry-After-Ms` /
 *    `X-Retry-After-Ms` (plain integer milliseconds)
 *  Returns `undefined` when no usable value is present. */
export function getRetryAfterMs(
  headers: Headers | Record<string, string> | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!headers) return undefined;
  const get = (name: string): string | null => {
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
    const rec = headers as Record<string, string>;
    for (const k of Object.keys(rec)) {
      if (k.toLowerCase() === name.toLowerCase()) return rec[k] ?? null;
    }
    return null;
  };
  const msVariant = get('retry-after-ms') ?? get('x-retry-after-ms');
  if (msVariant !== null) {
    const ms = Number(msVariant);
    if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms);
  }
  const raw = get('retry-after');
  if (raw === null) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.floor(secs * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return undefined;
}

/**
 * Per provider+model limiter. `acquire` gates a request; `noteRateLimited`
 * parks a provider+model in cooldown after a 429 (or any explicit signal).
 */
export class RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly cooldowns = new Map<string, number>();

  constructor(private readonly config: RateLimitConfig = DEFAULT_RATE_LIMIT) {}

  private key(providerId: string, model: string): string {
    return `${providerId}:${model}`;
  }

  acquire(providerId: string, model: string, now: number = Date.now()): AcquireResult {
    const k = this.key(providerId, model);
    const notBefore = this.cooldowns.get(k);
    if (notBefore !== undefined) {
      if (now < notBefore) return { ok: false, retryAfterMs: notBefore - now };
      this.cooldowns.delete(k); // expired — drop it
    }
    const windowStart = now - this.config.windowMs;
    const times = (this.windows.get(k) ?? []).filter((t) => t > windowStart);
    if (times.length >= this.config.maxRequests) {
      // times is ascending (we only append `now`); the oldest sets the wait.
      const waitMs = this.config.windowMs - (now - times[0]);
      this.windows.set(k, times);
      return { ok: false, retryAfterMs: Math.max(0, waitMs) };
    }
    times.push(now);
    this.windows.set(k, times);
    return { ok: true };
  }

  /** Park provider+model in cooldown for `retryAfterMs` (extends, never shortens). */
  noteRateLimited(
    providerId: string,
    model: string,
    retryAfterMs: number,
    now: number = Date.now(),
  ): void {
    const k = this.key(providerId, model);
    const until = now + Math.max(0, retryAfterMs);
    if (until > (this.cooldowns.get(k) ?? 0)) this.cooldowns.set(k, until);
  }

  /** How long until the provider+model may be used again (0 = usable now). */
  cooldownRemainingMs(providerId: string, model: string, now: number = Date.now()): number {
    const notBefore = this.cooldowns.get(this.key(providerId, model));
    return notBefore !== undefined && now < notBefore ? notBefore - now : 0;
  }

  clearCooldown(providerId: string, model: string): void {
    this.cooldowns.delete(this.key(providerId, model));
  }
}
