// Tests for streakBonus.ts — streak bonus rate-limit tiers.
//
// TIERS MUST stay in sync with
// packages/ext-agent/src/engagement/streakBonusTiers.ts (client mirror):
//   7d -> +100, 14d -> +200, 30d -> +500
import { describe, it, expect } from 'vitest';
import { getStreakBonus, parseStreakDays, MAX_STREAK_DAYS } from './streakBonus.js';

describe('getStreakBonus', () => {
  it('returns 0 below 7 days', () => {
    expect(getStreakBonus(0)).toBe(0);
    expect(getStreakBonus(1)).toBe(0);
    expect(getStreakBonus(6)).toBe(0);
  });

  it('7d -> +100', () => {
    expect(getStreakBonus(7)).toBe(100);
    expect(getStreakBonus(13)).toBe(100);
  });

  it('14d -> +200', () => {
    expect(getStreakBonus(14)).toBe(200);
    expect(getStreakBonus(29)).toBe(200);
  });

  it('30d -> +500', () => {
    expect(getStreakBonus(30)).toBe(500);
    expect(getStreakBonus(365)).toBe(500);
  });

  it('handles garbage defensively', () => {
    expect(getStreakBonus(-5)).toBe(0);
    expect(getStreakBonus(NaN)).toBe(0);
    expect(getStreakBonus(Infinity)).toBe(0);
    expect(getStreakBonus(7.9)).toBe(100); // floors
  });
});

describe('parseStreakDays', () => {
  it('parses header/query values', () => {
    expect(parseStreakDays('14')).toBe(14);
    expect(parseStreakDays('7')).toBe(7);
    expect(parseStreakDays(30)).toBe(30);
  });

  it('sanitizes garbage to 0 (never throws)', () => {
    expect(parseStreakDays('abc')).toBe(0);
    expect(parseStreakDays('')).toBe(0);
    expect(parseStreakDays(undefined)).toBe(0);
    expect(parseStreakDays(null)).toBe(0);
    expect(parseStreakDays('-3')).toBe(0);
    expect(parseStreakDays('1e999')).toBe(0);
    expect(parseStreakDays('999999')).toBe(MAX_STREAK_DAYS); // clamped
  });
});
