import { describe, it, expect } from 'vitest';
import { DailyQuota } from './quota.js';

describe('DailyQuota', () => {
  it('allows requests up to the daily limit', () => {
    const q = new DailyQuota(3);
    expect(q.tryConsume('gh:1').allowed).toBe(true);
    expect(q.tryConsume('gh:1').allowed).toBe(true);
    const third = q.tryConsume('gh:1');
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it('denies requests beyond the daily limit', () => {
    const q = new DailyQuota(2);
    q.tryConsume('gh:42');
    q.tryConsume('gh:42');
    const denied = q.tryConsume('gh:42');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.resetAfterMs).toBeGreaterThan(0);
    expect(denied.limit).toBe(2);
  });

  it('tracks users independently', () => {
    const q = new DailyQuota(1);
    q.tryConsume('gh:1');
    expect(q.tryConsume('gh:1').allowed).toBe(false);
    expect(q.tryConsume('gh:2').allowed).toBe(true);
  });

  it('reports remaining without consuming', () => {
    const q = new DailyQuota(5);
    q.tryConsume('gh:7');
    expect(q.remaining('gh:7')).toBe(4);
    expect(q.remaining('gh:8')).toBe(5);
  });

  it('rejects non-positive limits', () => {
    expect(() => new DailyQuota(0)).toThrow();
    expect(() => new DailyQuota(-1)).toThrow();
  });
});

describe('DailyQuota streak bonus', () => {
  it('applies the bonus band above the base quota', () => {
    const q = new DailyQuota(2);
    // 2 base requests (bonus 100 -> total 102).
    expect(q.tryConsumeWithBonus('gh:1', 100).quotaType).toBe('base');
    expect(q.tryConsumeWithBonus('gh:1', 100).quotaType).toBe('base');
    // 3rd request lands in the bonus band.
    const third = q.tryConsumeWithBonus('gh:1', 100);
    expect(third.allowed).toBe(true);
    expect(third.quotaType).toBe('streak_bonus');
    expect(third.limit).toBe(102);
    expect(third.remaining).toBe(99);
  });

  it('denies beyond base + bonus', () => {
    const q = new DailyQuota(1);
    q.tryConsumeWithBonus('gh:9', 1); // base
    q.tryConsumeWithBonus('gh:9', 1); // bonus
    const denied = q.tryConsumeWithBonus('gh:9', 1);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.limit).toBe(2);
    expect(denied.quotaType).toBe('streak_bonus');
  });

  it('bonus of 0 behaves exactly like tryConsume', () => {
    const q = new DailyQuota(1);
    const d = q.tryConsumeWithBonus('gh:5', 0);
    expect(d.allowed).toBe(true);
    expect(d.quotaType).toBe('base');
    expect(d.limit).toBe(1);
    expect(q.tryConsumeWithBonus('gh:5', 0).allowed).toBe(false);
  });

  it('sanitizes garbage bonus values', () => {
    const q = new DailyQuota(1);
    expect(q.tryConsumeWithBonus('a', NaN).limit).toBe(1);
    expect(q.tryConsumeWithBonus('b', -50).limit).toBe(1);
    expect(q.tryConsumeWithBonus('c', 10.9).limit).toBe(11); // floors to 10
  });

  it('tryConsume keeps its legacy shape (no quotaType)', () => {
    const q = new DailyQuota(1);
    const d = q.tryConsume('gh:legacy');
    expect(d.allowed).toBe(true);
    expect('quotaType' in d).toBe(false);
    expect(d.limit).toBe(1);
  });

  it('usedToday counts base + bonus usage', () => {
    const q = new DailyQuota(1);
    q.tryConsumeWithBonus('gh:u', 5);
    q.tryConsumeWithBonus('gh:u', 5);
    expect(q.usedToday('gh:u')).toBe(2);
    expect(q.usedToday('gh:nobody')).toBe(0);
  });

  it('quotaType is base again for a fresh user under the base limit', () => {
    const q = new DailyQuota(3);
    for (let i = 0; i < 3; i++) {
      expect(q.tryConsumeWithBonus('gh:x', 100).quotaType).toBe('base');
    }
    expect(q.tryConsumeWithBonus('gh:x', 100).quotaType).toBe('streak_bonus');
  });
});
