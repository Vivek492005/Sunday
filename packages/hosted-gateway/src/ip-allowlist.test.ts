import { describe, it, expect } from 'vitest';
import { ipAllowed, normalizeIp } from './ip-allowlist.js';

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp(undefined)).toBe('unknown');
  });
});

describe('ipAllowed', () => {
  it('allows everyone when the list is empty', () => {
    expect(ipAllowed('9.9.9.9', [])).toBe(true);
  });

  it('matches exact IPs', () => {
    expect(ipAllowed('10.0.0.5', ['10.0.0.5'])).toBe(true);
    expect(ipAllowed('10.0.0.6', ['10.0.0.5'])).toBe(false);
  });

  it('matches CIDR ranges', () => {
    expect(ipAllowed('192.168.1.77', ['192.168.1.0/24'])).toBe(true);
    expect(ipAllowed('192.168.2.1', ['192.168.1.0/24'])).toBe(false);
    expect(ipAllowed('10.5.6.7', ['10.0.0.0/8'])).toBe(true);
  });

  it('matches IPv4-mapped IPv6 client addresses', () => {
    expect(ipAllowed('::ffff:10.0.0.5', ['10.0.0.5'])).toBe(true);
  });

  it('rejects malformed entries safely (no crash, no match)', () => {
    expect(ipAllowed('10.0.0.5', ['not-an-ip'])).toBe(false);
    expect(ipAllowed('10.0.0.5', ['10.0.0.0/99'])).toBe(false);
  });
});
