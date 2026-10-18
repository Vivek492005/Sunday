import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consentInfo, hasConsented, recordConsent, revokeConsent } from './consent.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'hooks-consent-'));
  dirs.push(h);
  return h;
}

describe('consent (hash-pinned)', () => {
  it('no consent by default (fail closed)', () => {
    expect(hasConsented('abc123', home())).toBe(false);
  });
  it('record → has → revoke', () => {
    const h = home();
    recordConsent('abc123', '/ws', h);
    expect(hasConsented('abc123', h)).toBe(true);
    // A different hash (file changed) needs re-consent.
    expect(hasConsented('def456', h)).toBe(false);
    revokeConsent('abc123', h);
    expect(hasConsented('abc123', h)).toBe(false);
  });
  it('consentInfo returns the entry', () => {
    const h = home();
    expect(consentInfo('abc123', h)).toBeUndefined();
    recordConsent('abc123', '/ws', h);
    const info = consentInfo('abc123', h);
    expect(info?.workspaceRoot).toBe('/ws');
    expect(typeof info?.consentedAt).toBe('number');
  });
  it('corrupt store = no consent (fail closed)', () => {
    const h = home();
    mkdirSync(join(h, '.sunday'), { recursive: true });
    writeFileSync(join(h, '.sunday', 'hooks-consent.json'), 'not json{{{');
    expect(hasConsented('abc123', h)).toBe(false);
  });
});
