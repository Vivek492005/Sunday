import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateOrgKeyPair, signOrgBundle, OrgSignatureError } from './signing.js';
import { loadOrgPolicy, findOrgBundle, OrgLoadError } from './loader.js';
import type { UnsignedOrgBundleInput } from './schema.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'org-loader-'));
});

function writeSignedBundle(unsigned: UnsignedOrgBundleInput, privateKey: string, keyId: string): string {
  const signed = signOrgBundle(unsigned, privateKey, keyId);
  const p = join(dir, 'sunday-org.json');
  writeFileSync(p, JSON.stringify(signed, null, 2));
  return p;
}

const baseUnsigned: UnsignedOrgBundleInput = {
  version: 1,
  org: { id: 'acme', name: 'Acme Corp' },
  policy: { profile: 'cautious', locked: true },
  locked: ['policy.profile'],
};

describe('loadOrgPolicy', () => {
  it('loads a valid signed bundle', () => {
    const keys = generateOrgKeyPair('team-key');
    const p = writeSignedBundle(baseUnsigned, keys.privateKey, keys.keyId);
    const loaded = loadOrgPolicy(p, { publicKey: keys.publicKey });
    expect(loaded.bundle.org.id).toBe('acme');
    expect(loaded.verifiedKeyId).toBe('team-key');
    expect(loaded.path).toBe(p);
  });

  it('rejects a tampered bundle', () => {
    const keys = generateOrgKeyPair();
    const p = writeSignedBundle(baseUnsigned, keys.privateKey, keys.keyId);
    // Tamper after signing: flip the profile on disk.
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { policy: { profile: string } };
    raw.policy.profile = 'autopilot';
    writeFileSync(p, JSON.stringify(raw));
    expect(() => loadOrgPolicy(p, { publicKey: keys.publicKey })).toThrow(OrgSignatureError);
  });

  it('rejects when the wrong key is trusted', () => {
    const keys = generateOrgKeyPair();
    const other = generateOrgKeyPair();
    const p = writeSignedBundle(baseUnsigned, keys.privateKey, keys.keyId);
    expect(() => loadOrgPolicy(p, { publicKey: other.publicKey })).toThrow(OrgSignatureError);
  });

  it('rejects unsigned bundles by default', () => {
    const p = join(dir, 'sunday-org.json');
    writeFileSync(p, JSON.stringify({ version: 1, org: { id: 'x', name: 'X' } }));
    expect(() => loadOrgPolicy(p)).toThrow(OrgSignatureError);
  });

  it('loads unsigned bundles only with explicit allowUnsigned', () => {
    const p = join(dir, 'sunday-org.json');
    writeFileSync(p, JSON.stringify({ version: 1, org: { id: 'x', name: 'X' } }));
    const loaded = loadOrgPolicy(p, { allowUnsigned: true });
    expect(loaded.bundle.org.id).toBe('x');
    expect(loaded.verifiedKeyId).toBeNull();
  });

  it('throws OrgLoadError for missing file', () => {
    expect(() => loadOrgPolicy(join(dir, 'nope.json'))).toThrow(OrgLoadError);
  });

  it('throws OrgLoadError for invalid JSON', () => {
    const p = join(dir, 'sunday-org.json');
    writeFileSync(p, '{not json');
    expect(() => loadOrgPolicy(p)).toThrow(OrgLoadError);
  });

  it('resolves trusted key from SUNDAY_ORG_PUBLIC_KEY env', () => {
    const keys = generateOrgKeyPair('env-key');
    const p = writeSignedBundle(baseUnsigned, keys.privateKey, keys.keyId);
    process.env.SUNDAY_ORG_PUBLIC_KEY = keys.publicKey;
    try {
      const loaded = loadOrgPolicy(p);
      expect(loaded.verifiedKeyId).toBe('env-key');
    } finally {
      delete process.env.SUNDAY_ORG_PUBLIC_KEY;
    }
  });
});

describe('findOrgBundle', () => {
  it('walks up to find sunday-org.json', () => {
    const keys = generateOrgKeyPair();
    const p = writeSignedBundle(baseUnsigned, keys.privateKey, keys.keyId);
    expect(findOrgBundle(join(dir, 'a', 'b', 'c'))).toBe(p);
  });

  it('returns null when no bundle exists', () => {
    const empty = mkdtempSync(join(tmpdir(), 'org-empty-'));
    expect(findOrgBundle(empty)).toBeNull();
  });
});
