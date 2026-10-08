// sunday-agent — engagement: coding streak engine.
//
// Duolingo-style streaks with safety nets:
//   - Streak Freeze: earn 1 per 7-day streak (max 3 stored); a single missed
//     day auto-consumes a freeze instead of breaking the streak.
//   - Vacation Mode: pause the streak up to 14 days/year.
//   - Streak-at-risk: nudge eligibility (streak >= 3, no activity today,
//     after 6 PM local) — the UI layer decides whether to notify.
//
// Pure logic + JSON persistence (~/.sunday/engagement/streak.json). No vscode
// dependency. All time is injectable for tests.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ActivityStore,
  addDaysKey,
  dayKeyDiff,
  isStreakDay,
  localDayKey,
} from './activity.js';
import { getStreakBonus } from './streakBonusTiers.js';

export const FREEZE_EARN_EVERY_DAYS = 7;
export const MAX_FREEZES = 3;
export const VACATION_MAX_DAYS_PER_YEAR = 14;
export const STREAK_AT_RISK_MIN_DAYS = 3;
/** Local hour (24h) after which the at-risk nudge may fire. */
export const STREAK_AT_RISK_HOUR = 18;

export interface StreakState {
  current: number;
  longest: number;
  /** Day key of the most recent counted streak day, '' when never. */
  lastActiveDate: string;
  freezesAvailable: number;
  /** Highest streak count at which a freeze was earned (earn logic). */
  freezeMilestone: number;
  vacationDaysUsed: number;
  vacationYear: number;
  /** Inclusive start of the latest vacation, '' when never. */
  vacationStart: string;
  /** Inclusive end of vacation, '' when not on vacation. */
  vacationUntil: string;
  /** Day key of the last at-risk notification, '' when never. */
  lastRiskNotifiedDate: string;
  /** Highest milestone tier (7/14/30) already celebrated. 0 = none. */
  lastMilestoneNotifiedAt: number;
}

/** Streak lengths that unlock bonus rate limits (mirrors gateway tiers). */
export const MILESTONE_TIERS: readonly number[] = [7, 14, 30];

export function defaultStreakState(year: number): StreakState {
  return {
    current: 0,
    longest: 0,
    lastActiveDate: '',
    freezesAvailable: 0,
    freezeMilestone: 0,
    vacationDaysUsed: 0,
    vacationYear: year,
    vacationStart: '',
    vacationUntil: '',
    lastRiskNotifiedDate: '',
    lastMilestoneNotifiedAt: 0,
  };
}

export interface StreakInfo extends StreakState {
  todayKey: string;
  todayIsActive: boolean;
  onVacation: boolean;
  atRisk: boolean;
  /** Next bonus milestone, or null when at max tier. */
  nextMilestone: { daysAway: number; bonus: number; atDays: number } | null;
}

export class StreakStore {
  constructor(
    private readonly baseDir?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(): string {
    const dir = this.baseDir ?? path.join(os.homedir(), '.sunday', 'engagement');
    return path.join(dir, 'streak.json');
  }

  load(): StreakState {
    const year = this.now().getFullYear();
    try {
      const raw = fs.readFileSync(this.file(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<StreakState>;
      const s = { ...defaultStreakState(year), ...parsed };
      // Sanitize: never trust disk.
      s.current = Math.max(0, Math.floor(s.current) || 0);
      s.longest = Math.max(s.current, Math.floor(s.longest) || 0);
      s.freezesAvailable = Math.min(
        MAX_FREEZES,
        Math.max(0, Math.floor(s.freezesAvailable) || 0),
      );
      s.freezeMilestone = Math.max(0, Math.floor(s.freezeMilestone) || 0);
      s.vacationDaysUsed = Math.max(0, Math.floor(s.vacationDaysUsed) || 0);
      if (typeof s.lastActiveDate !== 'string') s.lastActiveDate = '';
      if (typeof s.vacationStart !== 'string') s.vacationStart = '';
      if (typeof s.vacationUntil !== 'string') s.vacationUntil = '';
      if (typeof s.lastRiskNotifiedDate !== 'string') s.lastRiskNotifiedDate = '';
      s.lastMilestoneNotifiedAt = Math.max(0, Math.floor(s.lastMilestoneNotifiedAt) || 0);
      return s;
    } catch {
      return defaultStreakState(year);
    }
  }

  save(s: StreakState): void {
    try {
      const f = this.file();
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, f);
    } catch {
      // Streaks must never break the IDE.
    }
  }
}

/**
 * Recompute the streak from activity + persisted state. Idempotent — safe to
 * call on every activation and after every recorded action.
 */
export function refreshStreak(
  store: StreakStore,
  activity: ActivityStore,
  now: Date = new Date(),
): StreakInfo {
  const s = store.load();
  const todayKey = localDayKey(now);

  // Roll the vacation year.
  if (s.vacationYear !== now.getFullYear()) {
    s.vacationYear = now.getFullYear();
    s.vacationDaysUsed = 0;
  }

  const onVacation = s.vacationUntil !== '' && todayKey <= s.vacationUntil;
  const todayActive = isStreakDay(activity.getDay(todayKey));

  if (!onVacation) {
    if (s.lastActiveDate === todayKey) {
      // Already counted today — nothing to do.
    } else if (!s.lastActiveDate) {
      if (todayActive) {
        s.current = 1;
        s.lastActiveDate = todayKey;
      }
    } else {
      // Missed-day gap, EXEMPTING vacation days: vacation neither increments
      // nor breaks the streak, so days inside the latest vacation window do
      // not count as missed.
      const exempt = vacationOverlapDays(s, s.lastActiveDate, todayKey);
      const gap = dayKeyDiff(s.lastActiveDate, todayKey) - exempt;
      if (gap === 1) {
        if (todayActive) {
          const prev = s.current;
          s.current += 1;
          s.lastActiveDate = todayKey;
          earnFreezes(s, prev);
        }
        // else: today still pending — streak stands.
      } else if (gap === 2) {
        // Missed exactly one full day.
        if (s.freezesAvailable > 0) {
          s.freezesAvailable -= 1;
          if (todayActive) {
            const prev = s.current;
            s.current += 1;
            s.lastActiveDate = todayKey;
            earnFreezes(s, prev);
          } else {
            // Frozen bridge: streak preserved, waiting on today.
            s.lastActiveDate = addDaysKey(todayKey, -1);
          }
        } else {
          breakStreak(s, todayActive, todayKey);
        }
      } else if (gap > 2 || gap < 0) {
        // Missed 2+ days (freezes bridge a single day only), or clock moved back.
        if (gap > 2) breakStreak(s, todayActive, todayKey);
      }
    }
    if (s.current > s.longest) s.longest = s.current;
  }

  store.save(s);

  const atRisk =
    !onVacation &&
    s.current >= STREAK_AT_RISK_MIN_DAYS &&
    !todayActive &&
    now.getHours() >= STREAK_AT_RISK_HOUR &&
    s.lastRiskNotifiedDate !== todayKey;

  return {
    ...s,
    todayKey,
    todayIsActive: todayActive,
    onVacation,
    atRisk,
    nextMilestone: nextMilestone(s.current),
  };
}

function breakStreak(s: StreakState, todayActive: boolean, todayKey: string): void {
  s.current = todayActive ? 1 : 0;
  s.lastActiveDate = todayActive ? todayKey : s.lastActiveDate;
}

/**
 * Number of vacation days inside the half-open range (afterKey, todayKey].
 * Day keys are ISO 'YYYY-MM-DD', so lexicographic comparison is chronological.
 */
function vacationOverlapDays(
  s: StreakState,
  afterKey: string,
  todayKey: string,
): number {
  if (s.vacationStart === '' || s.vacationUntil === '') return 0;
  const start = s.vacationStart > afterKey ? s.vacationStart : addDaysKey(afterKey, 1);
  const end = s.vacationUntil < todayKey ? s.vacationUntil : todayKey;
  if (start > end) return 0;
  return dayKeyDiff(start, end) + 1; // inclusive range
}

/** Earn 1 freeze per 7-day multiple crossed (cap 3 stored). */
function earnFreezes(s: StreakState, prevCurrent: number): void {
  const prevTier = Math.floor(prevCurrent / FREEZE_EARN_EVERY_DAYS);
  const newTier = Math.floor(s.current / FREEZE_EARN_EVERY_DAYS);
  for (let t = prevTier; t < newTier; t++) {
    if (s.freezesAvailable < MAX_FREEZES) s.freezesAvailable += 1;
    s.freezeMilestone = (t + 1) * FREEZE_EARN_EVERY_DAYS;
  }
}

/**
 * Start vacation mode for `days` days beginning today. Returns the inclusive
 * end day key, or null when the request is invalid (0/negative days, or over
 * the 14-day yearly allowance).
 */
export function setVacationMode(
  store: StreakStore,
  days: number,
  now: Date = new Date(),
): string | null {
  if (!Number.isInteger(days) || days <= 0) return null;
  const s = store.load();
  const year = now.getFullYear();
  const used = s.vacationYear === year ? s.vacationDaysUsed : 0;
  if (used + days > VACATION_MAX_DAYS_PER_YEAR) return null;
  const todayKey = localDayKey(now);
  const until = addDaysKey(todayKey, days - 1);
  const activeVacation = s.vacationUntil !== '' && todayKey <= s.vacationUntil;
  if (activeVacation && until <= s.vacationUntil) {
    // Requested window is fully inside the active vacation — nothing to do,
    // and no extra allowance is charged.
    return s.vacationUntil;
  }
  if (activeVacation) {
    // Extend (never shorten) the active vacation; the original start stands.
    s.vacationUntil = until;
  } else {
    // New vacation: record the window so the gap logic can exempt it.
    s.vacationStart = todayKey;
    s.vacationUntil = until;
  }
  s.vacationYear = year;
  s.vacationDaysUsed = used + days;
  store.save(s);
  return s.vacationUntil;
}

/** Mark the at-risk nudge as shown today (so it fires at most once/day). */
export function markRiskNotified(store: StreakStore, now: Date = new Date()): void {
  const s = store.load();
  s.lastRiskNotifiedDate = localDayKey(now);
  store.save(s);
}

/** Highest milestone tier reached for a streak length (0 when none). */
export function highestMilestoneReached(streakDays: number): number {
  let hit = 0;
  for (const t of MILESTONE_TIERS) {
    if (streakDays >= t) hit = t;
  }
  return hit;
}

/**
 * Record that the milestone celebration for `atDays` was shown.
 * Idempotent per tier.
 */
export function markMilestoneNotified(store: StreakStore, atDays: number): void {
  const s = store.load();
  if (atDays > s.lastMilestoneNotifiedAt) {
    s.lastMilestoneNotifiedAt = atDays;
    store.save(s);
  }
}

/** Next streak-bonus milestone, or null when at/above the top tier. */
export function nextMilestone(
  current: number,
): { daysAway: number; bonus: number; atDays: number } | null {
  const tiers = [
    { atDays: 7, bonus: 100 },
    { atDays: 14, bonus: 200 },
    { atDays: 30, bonus: 500 },
  ];
  for (const t of tiers) {
    if (current < t.atDays) {
      return { daysAway: t.atDays - current, bonus: t.bonus, atDays: t.atDays };
    }
  }
  return null;
}

/** Current streak-bonus tier (mirrors the gateway's streakBonus tiers). */
export function currentBonus(streakDays: number): number {
  return getStreakBonus(streakDays);
}
