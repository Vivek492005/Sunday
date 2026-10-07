import { describe, it, expect } from 'vitest';
import { DailyQuota } from './quota.js';

describe('DailyQuota', () => {
  it('allows requests up to the daily limit', () => {
    const q = new DailyQuota(3);
    expect(q.tryConsume(1).allowed).toBe(true);
    expect(q.tryConsume(1).allowed).toBe(true);
    const third = q.tryConsume(1);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it('denies requests beyond the daily limit', () => {
    const q = new DailyQuota(2);
    q.tryConsume(42);
    q.tryConsume(42);
    const denied = q.tryConsume(42);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.resetAfterMs).toBeGreaterThan(0);
    expect(denied.limit).toBe(2);
  });

  it('tracks users independently', () => {
    const q = new DailyQuota(1);
    q.tryConsume(1);
    expect(q.tryConsume(1).allowed).toBe(false);
    expect(q.tryConsume(2).allowed).toBe(true);
  });

  it('reports remaining without consuming', () => {
    const q = new DailyQuota(5);
    q.tryConsume(7);
    expect(q.remaining(7)).toBe(4);
    expect(q.remaining(8)).toBe(5);
  });

  it('rejects non-positive limits', () => {
    expect(() => new DailyQuota(0)).toThrow();
    expect(() => new DailyQuota(-1)).toThrow();
  });
});
