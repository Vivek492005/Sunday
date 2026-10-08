/**
 * @sunday/hosted-gateway — streak bonus rate limits.
 *
 * Coding streaks earn bonus managed requests/day on top of the base quota:
 *   7+ days  → +100/day
 *   14+ days → +200/day
 *   30+ days → +500/day
 *
 * TIERS MUST stay in sync with
 * packages/ext-agent/src/engagement/streakBonusTiers.ts (client mirror).
 *
 * ANTI-GAMING (v1): the server trusts the client's self-reported streakDays
 * (X-Sunday-Streak-Days header / streak_days query param). Streaks are
 * computed client-side from meaningful activity (commits, 30+ min editing,
 * PRs, AI tasks) — opening the app does not count. v2 will verify via
 * signed activity attestations; for now the bonus is small enough that
 * abuse is uneconomical (max +500/day on a free tier).
 */

export interface StreakBonusTier {
  minDays: number;
  bonus: number;
}

/** Ordered highest-first so the first match wins. */
export const STREAK_BONUS_TIERS: readonly StreakBonusTier[] = [
  { minDays: 30, bonus: 500 },
  { minDays: 14, bonus: 200 },
  { minDays: 7, bonus: 100 },
];

/** Upper bound for a sane streak value (10 years). */
export const MAX_STREAK_DAYS = 3650;

/** Bonus managed requests/day for a streak length. 0 when below 7 days. */
export function getStreakBonus(streakDays: number): number {
  const d = Math.floor(streakDays);
  if (!Number.isFinite(d) || d <= 0) return 0;
  for (const t of STREAK_BONUS_TIERS) {
    if (d >= t.minDays) return t.bonus;
  }
  return 0;
}

/**
 * Sanitize a client-supplied streak value (header or query param).
 * Non-numeric, negative, or absurd values → 0. Never throws.
 */
export function parseStreakDays(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_STREAK_DAYS, Math.max(0, Math.floor(n)));
}
