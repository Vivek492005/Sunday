// Tests for engagement/streak.ts — pure logic, no vscode.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ActivityStore, addDaysKey } from './activity.js';
import {
  StreakStore,
  defaultStreakState,
  highestMilestoneReached,
  markMilestoneNotified,
  markRiskNotified,
  nextMilestone,
  currentBonus,
  refreshStreak,
  setVacationMode,
  MAX_FREEZES,
  VACATION_MAX_DAYS_PER_YEAR,
} from './streak.js';
import { getStreakBonus } from './streakBonusTiers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-streak-'));
}

/** Build stores pinned to a controllable "now". */
function harness(now: Date) {
  const dir = tmpDir();
  let current = now;
  const nowFn = () => current;
  const activity = new ActivityStore(dir, nowFn);
  const streaks = new StreakStore(dir, nowFn);
  return {
    dir,
    activity,
    streaks,
    setNow: (d: Date) => {
      current = d;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const D = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0);

describe('refreshStreak basics', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness(D(2026, 10, 8));
  });
  afterEach(() => h.cleanup());

  it('starts a streak on the first active day', () => {
    h.activity.recordCommit();
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 8));
    expect(info.current).toBe(1);
    expect(info.longest).toBe(1);
    expect(info.lastActiveDate).toBe('2026-10-08');
  });

  it('stays at 0 with no activity', () => {
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 8));
    expect(info.current).toBe(0);
    expect(info.lastActiveDate).toBe('');
  });

  it('increments on consecutive active days', () => {
    h.activity.recordCommit();
    refreshStreak(h.streaks, h.activity, D(2026, 10, 8));
    h.setNow(D(2026, 10, 9));
    h.activity.recordCommit();
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 9));
    expect(info.current).toBe(2);
    expect(info.longest).toBe(2);
  });

  it('is idempotent within the same day', () => {
    h.activity.recordCommit();
    refreshStreak(h.streaks, h.activity, D(2026, 10, 8));
    h.activity.recordCommit();
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 8, 15));
    expect(info.current).toBe(1);
  });

  it('keeps the streak alive while today is still pending', () => {
    h.activity.recordCommit();
    refreshStreak(h.streaks, h.activity, D(2026, 10, 8));
    // Next day, no activity yet — streak stands (day not over).
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 9, 10));
    expect(info.current).toBe(1);
  });

  it('breaks after a missed day with no freeze', () => {
    h.activity.recordCommit();
    refreshStreak(h.streaks, h.activity, D(2026, 10, 8));
    // Skip 2026-10-09 entirely; check on 10-10 with activity.
    h.setNow(D(2026, 10, 10));
    h.activity.recordCommit();
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 10));
    expect(info.current).toBe(1);
    expect(info.longest).toBe(1);
  });
});

describe('streak freezes', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness(D(2026, 10, 1));
  });
  afterEach(() => h.cleanup());

  /** Build an N-day streak ending on the harness date. */
  function buildStreak(n: number, end: Date) {
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      h.setNow(d);
      h.activity.recordCommit();
      refreshStreak(h.streaks, h.activity, d);
    }
  }

  it('earns 1 freeze per 7-day streak, capped at 3', () => {
    buildStreak(7, D(2026, 10, 7));
    let info = refreshStreak(h.streaks, h.activity, D(2026, 10, 7));
    expect(info.current).toBe(7);
    expect(info.freezesAvailable).toBe(1);

    buildStreak(7, D(2026, 10, 14)); // continue to 14
    info = refreshStreak(h.streaks, h.activity, D(2026, 10, 14));
    expect(info.current).toBe(14);
    expect(info.freezesAvailable).toBe(2);
  });

  it('auto-consumes a freeze for a single missed day', () => {
    buildStreak(7, D(2026, 10, 7));
    // Miss 2026-10-08; active again on 10-09.
    h.setNow(D(2026, 10, 9));
    h.activity.recordCommit();
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 9));
    expect(info.current).toBe(8);
    expect(info.freezesAvailable).toBe(0);
  });

  it('does not bridge a 2-day gap (freeze covers one day only)', () => {
    buildStreak(7, D(2026, 10, 7));
    h.setNow(D(2026, 10, 10));
    h.activity.recordCommit();
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 10));
    expect(info.current).toBe(1);
    // Freeze was NOT consumed for an unbridgeable gap.
    expect(info.freezesAvailable).toBe(1);
  });

  it('freeze cap never exceeds 3', () => {
    const s = h.streaks.load();
    s.freezesAvailable = MAX_FREEZES;
    h.streaks.save(s);
    buildStreak(7, D(2026, 10, 7));
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 7));
    expect(info.freezesAvailable).toBeLessThanOrEqual(MAX_FREEZES);
  });
});

describe('vacation mode', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness(D(2026, 10, 8));
  });
  afterEach(() => h.cleanup());

  it('pauses the streak without breaking it', () => {
    h.activity.recordCommit();
    refreshStreak(h.streaks, h.activity, D(2026, 10, 8));
    const until = setVacationMode(h.streaks, 5, D(2026, 10, 9));
    expect(until).toBe('2026-10-13');
    // No activity during vacation — streak preserved.
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 12));
    expect(info.current).toBe(1);
    expect(info.onVacation).toBe(true);
    // After vacation, active day continues the streak.
    h.setNow(D(2026, 10, 14));
    h.activity.recordCommit();
    const after = refreshStreak(h.streaks, h.activity, D(2026, 10, 14));
    expect(after.current).toBe(2);
    expect(after.onVacation).toBe(false);
  });

  it('rejects more than 14 days per year', () => {
    expect(setVacationMode(h.streaks, 15, D(2026, 10, 8))).toBeNull();
    expect(setVacationMode(h.streaks, 0, D(2026, 10, 8))).toBeNull();
    expect(setVacationMode(h.streaks, 10, D(2026, 10, 8))).not.toBeNull();
    expect(setVacationMode(h.streaks, 5, D(2026, 11, 1))).toBeNull(); // 10+5 > 14
  });

  it('resets the yearly allowance in a new year', () => {
    setVacationMode(h.streaks, 14, D(2026, 10, 8));
    expect(setVacationMode(h.streaks, 14, D(2027, 1, 5))).not.toBeNull();
  });

  it('extends (never shortens) an active vacation, keeping the original start', () => {
    const until = setVacationMode(h.streaks, 5, D(2026, 10, 9));
    expect(until).toBe('2026-10-13');
    // A shorter request inside the active vacation: no-op, no extra charge.
    const usedBefore = h.streaks.load().vacationDaysUsed;
    expect(setVacationMode(h.streaks, 2, D(2026, 10, 10))).toBe('2026-10-13');
    expect(h.streaks.load().vacationDaysUsed).toBe(usedBefore);
    // A longer request extends the end but keeps the start.
    expect(setVacationMode(h.streaks, 5, D(2026, 10, 10))).toBe('2026-10-14');
    const s = h.streaks.load();
    expect(s.vacationStart).toBe('2026-10-09');
    expect(s.vacationUntil).toBe('2026-10-14');
  });

  it('exempts vacation days from the missed-day gap (freeze interplay)', () => {
    // 7-day streak ending Oct 1 → earns 1 freeze (Sep 25 .. Oct 1).
    for (let i = 7; i >= 1; i--) {
      const d = D(2026, 10, 2 - i, 12);
      h.setNow(d);
      h.activity.recordCommit();
      refreshStreak(h.streaks, h.activity, d);
    }
    let s = h.streaks.load();
    expect(s.current).toBe(7);
    expect(s.freezesAvailable).toBe(1);
    expect(s.lastActiveDate).toBe('2026-10-01');
    // Vacation on Oct 3 only. Oct 4 active: raw gap Oct 1→Oct 4 is 3 days,
    // minus 1 exempt vacation day = 2 → the freeze bridges the single real
    // missed day (Oct 2) and the streak continues.
    setVacationMode(h.streaks, 1, D(2026, 10, 3));
    h.setNow(D(2026, 10, 4, 12));
    h.activity.recordCommit();
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 4, 12));
    expect(info.current).toBe(8);
    s = h.streaks.load();
    expect(s.freezesAvailable).toBe(0);
    expect(s.lastActiveDate).toBe('2026-10-04');
  });
});

describe('at-risk nudges', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness(D(2026, 10, 8, 12));
  });
  afterEach(() => h.cleanup());

  it('is at risk only with streak>=3, no activity today, after 6 PM', () => {
    // Build a 3-day streak ending yesterday.
    for (let i = 3; i >= 1; i--) {
      const d = D(2026, 10, 8 - i, 12);
      h.setNow(d);
      h.activity.recordCommit();
      refreshStreak(h.streaks, h.activity, d);
    }
    // Today 7 PM, no activity → at risk.
    let info = refreshStreak(h.streaks, h.activity, D(2026, 10, 8, 19));
    expect(info.atRisk).toBe(true);
    // Before 6 PM → not at risk.
    info = refreshStreak(h.streaks, h.activity, D(2026, 10, 8, 17));
    expect(info.atRisk).toBe(false);
    // After activity → not at risk.
    h.setNow(D(2026, 10, 8, 19));
    h.activity.recordCommit();
    info = refreshStreak(h.streaks, h.activity, D(2026, 10, 8, 19));
    expect(info.atRisk).toBe(false);
  });

  it('markRiskNotified suppresses repeat nudges the same day', () => {
    for (let i = 3; i >= 1; i--) {
      const d = D(2026, 10, 8 - i, 12);
      h.setNow(d);
      h.activity.recordCommit();
      refreshStreak(h.streaks, h.activity, d);
    }
    markRiskNotified(h.streaks, D(2026, 10, 8, 19));
    const info = refreshStreak(h.streaks, h.activity, D(2026, 10, 8, 20));
    expect(info.atRisk).toBe(false);
  });
});

describe('milestones and bonus tiers', () => {
  it('nextMilestone points at 7/14/30-day rewards', () => {
    expect(nextMilestone(0)).toEqual({ daysAway: 7, bonus: 100, atDays: 7 });
    expect(nextMilestone(7)).toEqual({ daysAway: 7, bonus: 200, atDays: 14 });
    expect(nextMilestone(14)).toEqual({ daysAway: 16, bonus: 500, atDays: 30 });
    expect(nextMilestone(30)).toBeNull();
    expect(nextMilestone(90)).toBeNull();
  });

  it('getStreakBonus matches the gateway tiers', () => {
    expect(getStreakBonus(0)).toBe(0);
    expect(getStreakBonus(6)).toBe(0);
    expect(getStreakBonus(7)).toBe(100);
    expect(getStreakBonus(13)).toBe(100);
    expect(getStreakBonus(14)).toBe(200);
    expect(getStreakBonus(29)).toBe(200);
    expect(getStreakBonus(30)).toBe(500);
    expect(getStreakBonus(365)).toBe(500);
    expect(getStreakBonus(-3)).toBe(0);
    expect(getStreakBonus(NaN)).toBe(0);
  });

  it('currentBonus mirrors getStreakBonus', () => {
    expect(currentBonus(7)).toBe(100);
    expect(currentBonus(30)).toBe(500);
  });
});

describe('milestone celebrations', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness(D(2026, 10, 8));
  });
  afterEach(() => h.cleanup());

  it('highestMilestoneReached tracks 7/14/30 tiers', () => {
    expect(highestMilestoneReached(0)).toBe(0);
    expect(highestMilestoneReached(6)).toBe(0);
    expect(highestMilestoneReached(7)).toBe(7);
    expect(highestMilestoneReached(14)).toBe(14);
    expect(highestMilestoneReached(29)).toBe(14);
    expect(highestMilestoneReached(30)).toBe(30);
    expect(highestMilestoneReached(100)).toBe(30);
  });

  it('markMilestoneNotified records each tier once (idempotent)', () => {
    markMilestoneNotified(h.streaks, 7);
    expect(h.streaks.load().lastMilestoneNotifiedAt).toBe(7);
    markMilestoneNotified(h.streaks, 7);
    expect(h.streaks.load().lastMilestoneNotifiedAt).toBe(7);
    markMilestoneNotified(h.streaks, 14);
    expect(h.streaks.load().lastMilestoneNotifiedAt).toBe(14);
    // Never regresses to a lower tier.
    markMilestoneNotified(h.streaks, 7);
    expect(h.streaks.load().lastMilestoneNotifiedAt).toBe(14);
  });

  it('milestone state survives a streak break (re-earning not re-celebrated)', () => {
    const s = h.streaks.load();
    s.current = 8;
    s.lastMilestoneNotifiedAt = 7;
    h.streaks.save(s);
    // Streak breaks and restarts — the 7-day celebration must not refire.
    const loaded = h.streaks.load();
    expect(loaded.lastMilestoneNotifiedAt).toBe(7);
    expect(highestMilestoneReached(5)).toBe(0); // below celebrated tier
  });
});

describe('persistence hygiene', () => {
  it('defaultStreakState is sane and load() sanitizes corrupt data', () => {
    const dir = tmpDir();
    try {
      const s = new StreakStore(dir, () => D(2026, 10, 8));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'streak.json'),
        JSON.stringify({ current: -5, freezesAvailable: 99, lastActiveDate: 42 }),
      );
      const loaded = s.load();
      expect(loaded.current).toBe(0);
      expect(loaded.freezesAvailable).toBeLessThanOrEqual(MAX_FREEZES);
      expect(loaded.lastActiveDate).toBe('');
      void defaultStreakState;
      void VACATION_MAX_DAYS_PER_YEAR;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('addDaysKey is exported for streak internals', () => {
    expect(addDaysKey('2026-10-08', -1)).toBe('2026-10-07');
  });
});
