import { describe, it, expect } from 'vitest';
import { KeyRateLimiter, estimateTokens } from './rate-limit.js';

function makeLimiter(now: { t: number }, rpm = 60, tpm = 6000) {
  return new KeyRateLimiter({
    requestsPerMinute: rpm,
    tokensPerMinute: tpm,
    now: () => now.t,
  });
}

describe('KeyRateLimiter', () => {
  it('admits requests while buckets have capacity', () => {
    const now = { t: 0 };
    const l = makeLimiter(now);
    for (let i = 0; i < 60; i++) {
      const d = l.tryAdmit('k1', 10);
      expect(d.allowed).toBe(true);
    }
  });

  it('rejects the 61st request in the same minute with retryAfterMs', () => {
    const now = { t: 0 };
    const l = makeLimiter(now);
    for (let i = 0; i < 60; i++) l.tryAdmit('k1', 10);
    const d = l.tryAdmit('k1', 10);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(0);
    expect(d.remainingRequests).toBe(0);
  });

  it('refills over time', () => {
    const now = { t: 0 };
    const l = makeLimiter(now, 60, 6000);
    for (let i = 0; i < 60; i++) l.tryAdmit('k1', 10);
    expect(l.tryAdmit('k1', 10).allowed).toBe(false);
    now.t += 61_000; // a full minute passes
    expect(l.tryAdmit('k1', 10).allowed).toBe(true);
  });

  it('enforces the token budget independently of the request budget', () => {
    const now = { t: 0 };
    const l = makeLimiter(now, 1000, 100); // generous rpm, tiny tpm
    expect(l.tryAdmit('k1', 60).allowed).toBe(true);
    const d = l.tryAdmit('k1', 60);
    expect(d.allowed).toBe(false);
    expect(d.remainingTokens).toBeLessThan(60);
  });

  it('tracks keys independently', () => {
    const now = { t: 0 };
    const l = makeLimiter(now, 1, 6000);
    expect(l.tryAdmit('k1', 1).allowed).toBe(true);
    expect(l.tryAdmit('k1', 1).allowed).toBe(false);
    expect(l.tryAdmit('k2', 1).allowed).toBe(true);
  });
});

describe('estimateTokens', () => {
  it('estimates roughly chars/4 with a floor of 1', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});
