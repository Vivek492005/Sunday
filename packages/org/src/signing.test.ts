import { describe, it, expect } from 'vitest';
import type { UnsignedOrgBundleInput } from './schema.js';
import {
  generateOrgKeyPair,
  signOrgBundle,
  verifyOrgBundle,
  canonicalJson,
  OrgSignatureError,
} from './signing.js';

function unsignedBundle(): UnsignedOrgBundleInput {
  return {
    version: 1,
    org: { id: 'acme', name: 'Acme Corp' },
    rules: [{ name: 'no-secrets', text: 'Never commit secrets.' }],
    policy: { profile: 'balanced', locked: true },
    locked: ['policy.profile'],
  };
}

describe('ed25519 org bundle signing', () => {
  it('sign -> verify passes', () => {
    const keys = generateOrgKeyPair('k1');
    const signed = signOrgBundle(unsignedBundle(), keys.privateKey, keys.keyId);
    expect(signed.signature.algorithm).toBe('ed25519');
    expect(signed.signature.keyId).toBe('k1');
    expect(verifyOrgBundle(signed, keys.publicKey)).toBe(true);
  });

  it('defaults are normalized before signing (omitted fields still verify)', () => {
    const keys = generateOrgKeyPair();
    // no rules/hooks/locked keys at all — schema defaults apply on both sides
    const minimal: UnsignedOrgBundleInput = {
      version: 1,
      org: { id: 'acme', name: 'Acme' },
    };
    const signed = signOrgBundle(minimal, keys.privateKey, keys.keyId);
    expect(verifyOrgBundle(signed, keys.publicKey)).toBe(true);
  });

  it('tampered contents are rejected', () => {
    const keys = generateOrgKeyPair();
    const signed = signOrgBundle(unsignedBundle(), keys.privateKey, keys.keyId);
    const tampered = {
      ...signed,
      policy: { profile: 'autopilot' as const, locked: true }, // escalated!
    };
    expect(() => verifyOrgBundle(tampered, keys.publicKey)).toThrow(OrgSignatureError);
  });

  it('tampered rules are rejected', () => {
    const keys = generateOrgKeyPair();
    const signed = signOrgBundle(unsignedBundle(), keys.privateKey, keys.keyId);
    const tampered = { ...signed, rules: [{ name: 'x', text: 'evil' }] };
    expect(() => verifyOrgBundle(tampered, keys.publicKey)).toThrow(OrgSignatureError);
  });

  it('wrong public key is rejected', () => {
    const keys = generateOrgKeyPair();
    const other = generateOrgKeyPair();
    const signed = signOrgBundle(unsignedBundle(), keys.privateKey, keys.keyId);
    expect(() => verifyOrgBundle(signed, other.publicKey)).toThrow(OrgSignatureError);
  });

  it('flipped signature byte is rejected', () => {
    const keys = generateOrgKeyPair();
    const signed = signOrgBundle(unsignedBundle(), keys.privateKey, keys.keyId);
    const bytes = Buffer.from(signed.signature.value, 'hex');
    bytes[0] ^= 0xff;
    const bad = { ...signed, signature: { ...signed.signature, value: bytes.toString('hex') } };
    expect(() => verifyOrgBundle(bad, keys.publicKey)).toThrow(OrgSignatureError);
  });

  it('missing signature is rejected', () => {
    const keys = generateOrgKeyPair();
    const signed = signOrgBundle(unsignedBundle(), keys.privateKey, keys.keyId);
    const { signature: _signature, ...unsigned } = signed;
    void _signature;
    expect(() => verifyOrgBundle(unsigned as never, keys.publicKey)).toThrow(OrgSignatureError);
  });

  it('canonicalJson is key-order stable', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 1 } });
    const b = canonicalJson({ a: { c: 1, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":1,"d":2},"b":1}');
  });
});
