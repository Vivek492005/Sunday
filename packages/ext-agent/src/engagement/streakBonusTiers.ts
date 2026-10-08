// sunday-agent — engagement: streak bonus tiers (client-side mirror).
//
// MUST stay in sync with packages/hosted-gateway/src/streakBonus.ts.
// The gateway is authoritative; this copy lets the UI show milestones
// without a network round-trip.

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

/** Bonus managed requests/day for a streak length. 0 when below 7 days. */
export function getStreakBonus(streakDays: number): number {
  const d = Math.floor(streakDays);
  if (!Number.isFinite(d) || d <= 0) return 0;
  for (const t of STREAK_BONUS_TIERS) {
    if (d >= t.minDays) return t.bonus;
  }
  return 0;
}
