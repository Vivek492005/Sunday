// Tests for engagement/activity.ts — pure logic, no vscode.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ActivityStore,
  EditActivityTracker,
  addDaysKey,
  dayKeyDiff,
  isStreakDay,
  localDayKey,
  zeroDayActivity,
} from './activity.js';
import {
  __resetAgentUsedFlag,
  hasUsedAgentThisSession,
} from './mode.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-engagement-'));
}

describe('localDayKey / addDaysKey / dayKeyDiff', () => {
  it('formats local dates as YYYY-MM-DD', () => {
    expect(localDayKey(new Date(2026, 9, 8, 23, 59))).toBe('2026-10-08');
    expect(localDayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('shifts day keys across month boundaries', () => {
    expect(addDaysKey('2026-10-08', 1)).toBe('2026-10-09');
    expect(addDaysKey('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('computes whole-day differences', () => {
    expect(dayKeyDiff('2026-10-08', '2026-10-08')).toBe(0);
    expect(dayKeyDiff('2026-10-08', '2026-10-09')).toBe(1);
    expect(dayKeyDiff('2026-10-01', '2026-10-08')).toBe(7);
  });
});

describe('isStreakDay', () => {
  it('requires meaningful work, not just opening the app', () => {
    expect(isStreakDay(zeroDayActivity())).toBe(false);
    expect(isStreakDay({ ...zeroDayActivity(), testsRun: 10 })).toBe(false);
    expect(isStreakDay({ ...zeroDayActivity(), editMinutes: 29 })).toBe(false);
  });

  it('counts commits, 30+ min editing, PRs, AI tasks', () => {
    expect(isStreakDay({ ...zeroDayActivity(), commits: 1 })).toBe(true);
    expect(isStreakDay({ ...zeroDayActivity(), editMinutes: 30 })).toBe(true);
    expect(isStreakDay({ ...zeroDayActivity(), prsMerged: 1 })).toBe(true);
    expect(isStreakDay({ ...zeroDayActivity(), aiTasks: 1 })).toBe(true);
  });
});

describe('ActivityStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
    __resetAgentUsedFlag();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records each action type into today\'s bucket', () => {
    const store = new ActivityStore(dir, () => new Date(2026, 9, 8, 12, 0));
    store.recordCommit();
    store.recordCommit();
    store.recordEditMinutes(45);
    store.recordPRMerged();
    store.recordAITaskCompleted();
    store.recordTestRun();
    const d = store.getDay('2026-10-08');
    expect(d).toMatchObject({
      commits: 2,
      editMinutes: 45,
      prsMerged: 1,
      aiTasks: 1,
      testsRun: 1,
    });
  });

  it('recordAITaskCompleted flips the session into active engagement mode', () => {
    expect(hasUsedAgentThisSession()).toBe(false);
    const store = new ActivityStore(dir, () => new Date(2026, 9, 8, 12, 0));
    store.recordAITaskCompleted();
    expect(hasUsedAgentThisSession()).toBe(true);
  });

  it('plain editing does NOT flip the mode (passive stays passive)', () => {
    const store = new ActivityStore(dir, () => new Date(2026, 9, 8, 12, 0));
    store.recordCommit();
    store.recordEditMinutes(60);
    expect(hasUsedAgentThisSession()).toBe(false);
  });

  it('persists across instances', () => {
    const mk = () => new ActivityStore(dir, () => new Date(2026, 9, 8, 12, 0));
    mk().recordCommit();
    expect(mk().getDay('2026-10-08').commits).toBe(1);
  });

  it('returns zeroed activity for unknown days and corrupt files', () => {
    const store = new ActivityStore(dir);
    expect(store.getDay('1999-01-01')).toEqual(zeroDayActivity());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'activity.json'), 'not json{{{');
    expect(new ActivityStore(dir).getDay('2026-10-08')).toEqual(zeroDayActivity());
  });

  it('prunes data older than 400 days', () => {
    const store = new ActivityStore(dir, () => new Date(2026, 9, 8, 12, 0));
    const days = store.load() as Record<string, ReturnType<typeof zeroDayActivity>>;
    days['2020-01-01'] = { ...zeroDayActivity(), commits: 9 };
    // Write directly, then trigger prune via record().
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'activity.json'),
      JSON.stringify({ version: 1, days }),
    );
    store.recordCommit();
    expect(store.load()['2020-01-01']).toBeUndefined();
    expect(store.getDay('2026-10-08').commits).toBe(1);
  });
});

describe('EditActivityTracker', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accumulates minutes for edits within the session gap', () => {
    const store = new ActivityStore(dir, () => new Date(2026, 9, 8, 12, 0));
    const t = new EditActivityTracker(store, () => 0);
    const base = 1_700_000_000_000;
    t.noteEdit(base);
    t.noteEdit(base + 2 * 60_000); // +2 min
    t.noteEdit(base + 4 * 60_000); // +2 min
    expect(store.getDay('2026-10-08').editMinutes).toBeCloseTo(4, 5);
  });

  it('ignores idle gaps longer than 5 minutes', () => {
    const store = new ActivityStore(dir, () => new Date(2026, 9, 8, 12, 0));
    const t = new EditActivityTracker(store, () => 0);
    const base = 1_700_000_000_000;
    t.noteEdit(base);
    t.noteEdit(base + 60 * 60_000); // 1h idle — not counted
    expect(store.getDay('2026-10-08').editMinutes).toBe(0);
  });

  it('reset() breaks the session so idle time is never counted', () => {
    const store = new ActivityStore(dir, () => new Date(2026, 9, 8, 12, 0));
    const t = new EditActivityTracker(store, () => 0);
    const base = 1_700_000_000_000;
    t.noteEdit(base);
    t.reset();
    t.noteEdit(base + 3 * 60_000);
    expect(store.getDay('2026-10-08').editMinutes).toBe(0);
  });
});
