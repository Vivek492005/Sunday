/**
 * @sunday/hosted-gateway — per-user daily quota (free tier).
 *
 * Each GitHub user id gets `requestsPerDay` chat requests per UTC day.
 * Counters reset at UTC midnight. In-memory only — a restart resets
 * quotas, which is acceptable for a free tier (fail-open on generosity,
 * fail-closed on abuse via the per-minute rate limiter which persists
 * per process anyway).
 */

export interface QuotaDecision {
  allowed: boolean;
  /** Requests remaining today (0 when denied). */
  remaining: number;
  /** Ms until the quota resets (UTC midnight). */
  resetAfterMs: number;
  /** The daily limit. */
  limit: number;
}

export class DailyQuota {
  private readonly counts = new Map<number, { day: string; used: number }>();

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
  tryConsume(githubUserId: number): QuotaDecision {
    const day = this.today();
    const entry = this.counts.get(githubUserId);
    const used = entry && entry.day === day ? entry.used : 0;
    const resetAfterMs = this.msUntilMidnightUtc();

    if (used >= this.requestsPerDay) {
      return { allowed: false, remaining: 0, resetAfterMs, limit: this.requestsPerDay };
    }

    this.counts.set(githubUserId, { day, used: used + 1 });

    // Opportunistic cleanup of stale days.
    if (this.counts.size > 100_000) {
      for (const [k, v] of this.counts) {
        if (v.day !== day) this.counts.delete(k);
      }
    }

    return {
      allowed: true,
      remaining: this.requestsPerDay - used - 1,
      resetAfterMs,
      limit: this.requestsPerDay,
    };
  }

  /** How many requests a user has left today (no consumption). */
  remaining(githubUserId: number): number {
    const day = this.today();
    const entry = this.counts.get(githubUserId);
    const used = entry && entry.day === day ? entry.used : 0;
    return Math.max(0, this.requestsPerDay - used);
  }
}
