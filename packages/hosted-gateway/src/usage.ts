/**
 * @sunday/hosted-gateway — per-user usage metering for the /me/usage dashboard.
 *
 * Aggregates chat-completion usage (requests + estimated tokens) per auth
 * key so the IDE's "Sunday Usage" panel can show today's totals, per-model
 * breakdowns, and a 7-day history.
 *
 * PERSISTENCE LIMITATION: in-memory only — a gateway restart loses all
 * history, exactly like the daily quota counters in quota.ts. This is an
 * accepted free-tier tradeoff (no user analytics store yet); the dashboard
 * degrades to an empty-but-valid snapshot after a restart. If persistent
 * analytics are ever needed, swap the backing store for the JSON-file
 * pattern used by AccountsService (0600 files under the data dir).
 */

import type { QuotaType } from './quota.js';

export interface UsageDayPoint {
  day: string;
  requests: number;
}

export interface UsageModelPoint {
  model: string;
  requests: number;
  tokens: number;
}

export interface UsageSnapshot {
  today: {
    requests: number;
    tokens_in: number;
    tokens_out: number;
    /** Requests served from the base quota (absent in older snapshots). */
    base_requests?: number;
    /** Requests served from the streak-bonus band. */
    bonus_requests?: number;
  };
  by_model: UsageModelPoint[];
  history_7d: UsageDayPoint[];
}

interface DayBucket {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  baseRequests: number;
  bonusRequests: number;
  models: Map<string, { requests: number; tokens: number }>;
}

/** Days of history retained per user (7 shown + 1 spare for day boundaries). */
const RETAIN_DAYS = 8;

export class UsageMeter {
  /** userKey -> UTC day (YYYY-MM-DD) -> bucket */
  private readonly days = new Map<string, Map<string, DayBucket>>();

  private static dayKey(atMs: number): string {
    return new Date(atMs).toISOString().slice(0, 10);
  }

  private bucket(userKey: string, day: string): DayBucket {
    let perUser = this.days.get(userKey);
    if (!perUser) {
      perUser = new Map();
      this.days.set(userKey, perUser);
    }
    let b = perUser.get(day);
    if (!b) {
      b = { requests: 0, tokensIn: 0, tokensOut: 0, baseRequests: 0, bonusRequests: 0, models: new Map() };
      perUser.set(day, b);
    }
    return b;
  }

  /**
   * Record one completed chat completion for a user key.
   * quotaType labels whether the request was served from the base quota or
   * the streak-bonus band (metering keeps the two separate).
   */
  record(
    userKey: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    atMs: number = Date.now(),
    quotaType: QuotaType = 'base',
  ): void {
    if (!userKey || !model) return;
    const day = UsageMeter.dayKey(atMs);
    const b = this.bucket(userKey, day);
    const ti = Math.max(0, Math.floor(tokensIn) || 0);
    const to = Math.max(0, Math.floor(tokensOut) || 0);
    b.requests += 1;
    b.tokensIn += ti;
    b.tokensOut += to;
    if (quotaType === 'streak_bonus') b.bonusRequests += 1;
    else b.baseRequests += 1;
    const m = b.models.get(model) ?? { requests: 0, tokens: 0 };
    m.requests += 1;
    m.tokens += ti + to;
    b.models.set(model, m);
    this.prune(userKey);
  }

  /** Drop day buckets older than RETAIN_DAYS. */
  private prune(userKey: string): void {
    const perUser = this.days.get(userKey);
    if (!perUser) return;
    const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
    for (const day of [...perUser.keys()]) {
      if (Date.parse(`${day}T00:00:00Z`) < cutoff) perUser.delete(day);
    }
    if (perUser.size === 0) this.days.delete(userKey);
  }

  /** Snapshot for the /me/usage response. Empty data -> zeroed snapshot. */
  snapshot(userKey: string): UsageSnapshot {
    const perUser = this.days.get(userKey);
    const today = UsageMeter.dayKey(Date.now());
    const t = perUser?.get(today);

    const byModel = new Map<string, { requests: number; tokens: number }>();
    if (perUser) {
      for (const b of perUser.values()) {
        for (const [model, m] of b.models) {
          const agg = byModel.get(model) ?? { requests: 0, tokens: 0 };
          agg.requests += m.requests;
          agg.tokens += m.tokens;
          byModel.set(model, agg);
        }
      }
    }

    const history: UsageDayPoint[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      history.push({ day: d, requests: perUser?.get(d)?.requests ?? 0 });
    }

    return {
      today: {
        requests: t?.requests ?? 0,
        tokens_in: t?.tokensIn ?? 0,
        tokens_out: t?.tokensOut ?? 0,
        base_requests: t?.baseRequests ?? 0,
        bonus_requests: t?.bonusRequests ?? 0,
      },
      by_model: [...byModel.entries()]
        .map(([model, m]) => ({ model, requests: m.requests, tokens: m.tokens }))
        .sort((a, b) => b.requests - a.requests),
      history_7d: history,
    };
  }
}
