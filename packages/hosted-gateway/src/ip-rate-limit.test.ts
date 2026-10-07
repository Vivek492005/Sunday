/**
 * S8: gateway hardening — per-IP rate limiting backstop.
 */
import { describe, expect, it } from 'vitest';
import { IpRateLimiter } from './rate-limit.js';

describe('S8: IpRateLimiter', () => {
  it('admits up to the per-minute cap', () => {
    let now = 0;
    const lim = new IpRateLimiter({ requestsPerMinute: 5, now: () => now });
    for (let i = 0; i < 5; i++) expect(lim.tryAdmit('1.2.3.4')).toBe(true);
    expect(lim.tryAdmit('1.2.3.4')).toBe(false);
  });

  it('refills over time', () => {
    let now = 0;
    const lim = new IpRateLimiter({ requestsPerMinute: 60, now: () => now });
    for (let i = 0; i < 60; i++) lim.tryAdmit('1.2.3.4');
    expect(lim.tryAdmit('1.2.3.4')).toBe(false);
    now += 61_000; // a minute later — full refill
    expect(lim.tryAdmit('1.2.3.4')).toBe(true);
  });

  it('tracks IPs independently', () => {
    let now = 0;
    const lim = new IpRateLimiter({ requestsPerMinute: 1, now: () => now });
    expect(lim.tryAdmit('1.1.1.1')).toBe(true);
    expect(lim.tryAdmit('1.1.1.1')).toBe(false);
    expect(lim.tryAdmit('2.2.2.2')).toBe(true);
  });
});
