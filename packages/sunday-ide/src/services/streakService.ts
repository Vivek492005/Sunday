/**
 * Streak service (renderer) — typed access to the `window.sunday.streak`
 * bridge (electron/streakService.ts in the main process, over the real
 * ext-agent engagement engine).
 *
 * StreakInfoOut mirrors StreakInfo from
 * packages/ext-agent/src/engagement/streak.ts — the coordinator mirrors this
 * exact shape into electron/preload.ts as the bridge's return type.
 */

export interface StreakInfoOut {
  current: number;
  longest: number;
  /** Day key of the most recent counted streak day, '' when never. */
  lastActiveDate: string;
  freezesAvailable: number;
  freezeMilestone: number;
  vacationDaysUsed: number;
  vacationYear: number;
  vacationStart: string;
  vacationUntil: string;
  lastRiskNotifiedDate: string;
  lastMilestoneNotifiedAt: number;
  todayKey: string;
  todayIsActive: boolean;
  onVacation: boolean;
  atRisk: boolean;
  /** Next bonus milestone, or null when at max tier. */
  nextMilestone: { daysAway: number; bonus: number; atDays: number } | null;
}

interface StreakBridge {
  get(): Promise<StreakInfoOut>;
  noteEdit(): Promise<void>;
}

function streakBridge(): StreakBridge {
  const api = (window as unknown as { sunday?: { streak?: StreakBridge } }).sunday;
  if (!api?.streak) {
    throw new Error(
      'Sunday bridge unavailable — the Sunday IDE renderer must run inside the Electron shell (`pnpm dev`).',
    );
  }
  return api.streak;
}

export const streakService = {
  /** Current streak info (recomputed from real activity in the main process). */
  get: (): Promise<StreakInfoOut> => streakBridge().get(),

  /**
   * Report an editor edit so the main-process EditActivityTracker can accrue
   * active-editing minutes. Fire-and-forget: editing must never fail because
   * engagement bookkeeping did, so errors are swallowed here. On success it
   * dispatches 'sunday:streak:changed' so useStreakInfo() refreshes promptly
   * instead of waiting for its 60s poll.
   */
  noteEdit: async (): Promise<void> => {
    try {
      await streakBridge().noteEdit();
      window.dispatchEvent(new CustomEvent('sunday:streak:changed'));
    } catch {
      // Fire-and-forget by design (see above).
    }
  },
};
