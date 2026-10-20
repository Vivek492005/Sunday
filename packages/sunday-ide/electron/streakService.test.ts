/**
 * streakService tests — REAL engine, REAL disk persistence, no mocks.
 *
 * Injection seam: StreakStore/ActivityStore accept a `baseDir` constructor
 * arg (verified in packages/ext-agent/src/engagement/), forwarded by
 * createStreakService — so every test runs against a fresh temp dir instead
 * of the developer's real ~/.sunday/engagement.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStreakService, type StreakService } from './streakService.js';
import {
  StreakStore,
  refreshStreak,
} from '../../ext-agent/src/engagement/streak.js';
import { ActivityStore } from '../../ext-agent/src/engagement/activity.js';

let dir: string;
let svc: StreakService;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-streak-'));
  svc = createStreakService(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('streakService (real ext-agent engagement engine)', () => {
  it('fresh state: current 0, today not active', () => {
    const info = svc.getStreakInfo();
    expect(info.current).toBe(0);
    expect(info.longest).toBe(0);
    expect(info.todayIsActive).toBe(false);
    expect(info.freezesAvailable).toBe(0);
  });

  it('a completed AI task today starts the streak at 1 and persists to disk', () => {
    svc.recordAgentTaskCompleted();
    const info = svc.getStreakInfo();
    expect(info.current).toBe(1);
    expect(info.longest).toBe(1);
    expect(info.todayIsActive).toBe(true);

    // Persisted: raw files exist in the injected baseDir…
    expect(fs.existsSync(path.join(dir, 'activity.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'streak.json'))).toBe(true);

    // …and a brand-new store pair over the same dir recomputes the same streak.
    const reread = refreshStreak(new StreakStore(dir), new ActivityStore(dir));
    expect(reread.current).toBe(1);
    expect(reread.todayIsActive).toBe(true);

    // A second service instance over the same dir agrees (no in-memory-only state).
    expect(createStreakService(dir).getStreakInfo().current).toBe(1);
  });

  it('a git commit also qualifies the day', () => {
    svc.recordCommitMade();
    const info = svc.getStreakInfo();
    expect(info.current).toBe(1);
    expect(info.todayIsActive).toBe(true);
  });

  it('a test run alone does NOT qualify the day (engine bar: shipped work)', () => {
    svc.recordTestsRan();
    const info = svc.getStreakInfo();
    expect(info.current).toBe(0);
    expect(info.todayIsActive).toBe(false);
  });

  it('30+ minutes of active editing (≤5 min gaps) qualifies the day', () => {
    const t0 = Date.now();
    const fourMin = 4 * 60_000;
    // 9 edits, 4 minutes apart → 32 active minutes accumulated by the tracker.
    for (let k = 0; k <= 8; k++) svc.noteEditActivity(t0 + k * fourMin);
    const info = svc.getStreakInfo();
    expect(info.todayIsActive).toBe(true);
    expect(info.current).toBe(1);
  });

  it('a few minutes of editing does not qualify the day', () => {
    const t0 = Date.now();
    svc.noteEditActivity(t0);
    svc.noteEditActivity(t0 + 2 * 60_000);
    expect(svc.getStreakInfo().todayIsActive).toBe(false);
  });

  it('resetEditActivity drops the in-progress edit session without throwing', () => {
    const t0 = Date.now();
    svc.noteEditActivity(t0);
    svc.resetEditActivity();
    // After a reset, the next edit starts a new session — no minutes credited
    // for the (idle) gap across the reset.
    svc.noteEditActivity(t0 + 60 * 60_000);
    expect(svc.getStreakInfo().todayIsActive).toBe(false);
  });
});
