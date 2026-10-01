import { describe, expect, it } from 'vitest';
import { BrowserPolicy, BrowserPolicyError } from './policy.js';

function decide(url: string, approved: string[] = [], domains: string[] = []) {
  const policy = new BrowserPolicy({ approvedDomains: domains });
  return policy.checkNavigation(url, new Set(approved));
}

describe('BrowserPolicy', () => {
  it('blocks file:// always', () => {
    expect(() => decide('file:///etc/passwd')).toThrow(BrowserPolicyError);
    expect(() => decide('file:///etc/passwd')).toThrow(/file:\/\//);
  });

  it('blocks non-http(s) schemes', () => {
    expect(() => decide('javascript:alert(1)')).toThrow(BrowserPolicyError);
    expect(() => decide('data:text/html,<h1>x</h1>')).toThrow(BrowserPolicyError);
    expect(() => decide('chrome://settings')).toThrow(BrowserPolicyError);
  });

  it('blocks invalid URLs', () => {
    expect(() => decide('not a url')).toThrow(BrowserPolicyError);
    expect(() => decide('http://')).toThrow(BrowserPolicyError);
  });

  it('blocks private IPv4 ranges unless user-approved', () => {
    for (const host of ['192.168.1.10', '10.0.0.5', '172.16.4.2', '172.31.255.1', '169.254.169.254']) {
      expect(() => decide(`http://${host}/`), `host ${host}`).toThrow(/private network/);
    }
  });

  it('blocks private IPv6 ranges', () => {
    expect(() => decide('http://[fc00::1]/')).toThrow(/private network/);
    expect(() => decide('http://[fe80::1]/')).toThrow(/private network/);
  });

  it('always allows loopback', () => {
    expect(decide('http://localhost:3000/')).toEqual({ kind: 'allow' });
    expect(decide('http://127.0.0.1:8080/x')).toEqual({ kind: 'allow' });
    expect(decide('http://[::1]:3000/')).toEqual({ kind: 'allow' });
  });

  it('allows user-approved domains, exact and subdomain', () => {
    expect(decide('https://example.com/', [], ['example.com'])).toEqual({ kind: 'allow' });
    expect(decide('https://app.example.com/a', [], ['example.com'])).toEqual({ kind: 'allow' });
    // lookalike suffix must not match
    const d = decide('https://notexample.com/', [], ['example.com']);
    expect(d.kind).toBe('needsApproval');
  });

  it('allows an approved private IP when the user approved its domain entry', () => {
    // approvedDomains is domain-based; a private IP listed there is an
    // explicit user approval and wins over the private-range block.
    expect(decide('http://192.168.1.10/', [], ['192.168.1.10'])).toEqual({ kind: 'allow' });
  });

  it('returns needsApproval once for a new public origin', () => {
    const d = decide('https://example.com/docs');
    expect(d).toEqual({ kind: 'needsApproval', origin: 'https://example.com' });
    // …and allows it after the client approved the origin.
    expect(decide('https://example.com/other', ['https://example.com'])).toEqual({ kind: 'allow' });
    // A different origin still needs its own approval.
    expect(decide('https://other.org/', ['https://example.com']).kind).toBe('needsApproval');
  });

  it('treats ports as part of the origin', () => {
    const d = decide('http://example.com:4000/');
    expect(d).toEqual({ kind: 'needsApproval', origin: 'http://example.com:4000' });
  });

  it('host matching is case-insensitive', () => {
    expect(decide('http://LOCALHOST:3000/')).toEqual({ kind: 'allow' });
  });
});
