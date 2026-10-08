/**
 * @sunday/hosted-gateway — per-user daily quota (free tier).
 *
 * Each GitHub user id gets `requestsPerDay` chat requests per UTC day.
 * Counters reset at UTC midnight. In-memory only — a restart resets
 * quotas, which is acceptable for a free tier (fail-open on generosity,
 * fail-closed on abuse via the per-minute rate limiter which persists
 * per process anyway).
 */

export type QuotaType = 'base' | 'streak_bonus';

export interface QuotaDecision {
  allowed: boolean;
  /** Requests remaining today (0 when denied). */
  remaining: number;
  /** Ms until the quota resets (UTC midnight). */
  resetAfterMs: number;
  /** The daily limit (base + streak bonus when applicable). */
  limit: number;
  /**
   * Which quota bucket the consumed (or would-be) request falls in.
   * 'base' = within the plan's base quota, 'streak_bonus' = within the
   * streak bonus band. Present only on tryConsumeWithBonus.
   */
  quotaType?: QuotaType;
}

export class DailyQuota {
  private readonly counts = new Map<string, { day: string; used: number }>();

  constructor(private readonly requestsPerDay: number) {
    if (!Number.isFinite(requestsPerDay) || requestsPerDay <= 0) {
      throw new Error('requestsPerDay must be a positive number');
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10); // UTC date
  }

  private msUntilMidnightUtc(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return midnight.getTime() - now.getTime();
  }

  /** Record one request for a GitHub user id. */
  tryConsume(userKey: string): QuotaDecision {
    const d = this.tryConsumeWithBonus(userKey, 0);
    // Preserve the exact legacy shape for existing callers/tests.
    const { quotaType: _qt, ...legacy } = d;
    return legacy;
  }

  /**
   * Record one request with a streak bonus applied on top of the base quota.
   * The bonus band sits strictly above the base quota: the first
   * `requestsPerDay` requests of the day are 'base', anything beyond (up to
   * base + bonus) is 'streak_bonus'. Denied requests report the bucket they
   * would have consumed.
   */
  tryConsumeWithBonus(userKey: string, bonus: number): QuotaDecision {
    const extra =
      Number.isFinite(bonus) && bonus > 0 ? Math.floor(bonus) : 0;
    const limit = this.requestsPerDay + extra;
    const day = this.today();
    const entry = this.counts.get(userKey);
    const used = entry && entry.day === day ? entry.used : 0;
    const resetAfterMs = this.msUntilMidnightUtc();
    const quotaType: QuotaType = used < this.requestsPerDay ? 'base' : 'streak_bonus';

    if (used >= limit) {
      return { allowed: false, remaining: 0, resetAfterMs, limit, quotaType };
    }

    this.counts.set(userKey, { day, used: used + 1 });

    // Opportunistic cleanup of stale days.
    if (this.counts.size > 100_000) {
      for (const [k, v] of this.counts) {
        if (v.day !== day) this.counts.delete(k);
      }
    }

    return {
      allowed: true,
      remaining: limit - used - 1,
      resetAfterMs,
      limit,
      quotaType,
    };
  }

  /** Requests consumed today (no consumption). Includes bonus-band usage. */
  usedToday(userKey: string): number {
    const day = this.today();
    const entry = this.counts.get(userKey);
    return entry && entry.day === day ? entry.used : 0;
  }

  /** Ms until the quota resets (UTC midnight). */
  msUntilReset(): number {
    return this.msUntilMidnightUtc();
  }

  /** How many requests a user has left today (no consumption). */
  remaining(userKey: string): number {
    const day = this.today();
    const entry = this.counts.get(userKey);
    const used = entry && entry.day === day ? entry.used : 0;
    return Math.max(0, this.requestsPerDay - used);
  }
}
