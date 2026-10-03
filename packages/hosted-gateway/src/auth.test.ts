import { describe, it, expect } from 'vitest';
import { KeyStore, keyFingerprint } from './auth.js';

describe('KeyStore.extractBearer', () => {
  it('extracts the token from a Bearer header', () => {
    expect(KeyStore.extractBearer('Bearer abc123')).toBe('abc123');
    expect(KeyStore.extractBearer('bearer abc123')).toBe('abc123');
    expect(KeyStore.extractBearer('Bearer  abc123  ')).toBe('abc123');
  });

  it('rejects non-Bearer schemes and junk', () => {
    expect(KeyStore.extractBearer(undefined)).toBeUndefined();
    expect(KeyStore.extractBearer('Basic abc123')).toBeUndefined();
    expect(KeyStore.extractBearer('Bearer')).toBeUndefined();
    expect(KeyStore.extractBearer('')).toBeUndefined();
    expect(KeyStore.extractBearer('Bearer a b')).toBeUndefined();
  });
});

describe('KeyStore.verify', () => {
  const store = new KeyStore([
    { id: 'alice', secret: 's3cret-alice' },
    { id: 'bob', secret: 's3cret-bob' },
  ]);

  it('verifies a correct secret', () => {
    expect(store.verify('s3cret-alice')?.id).toBe('alice');
    expect(store.verify('s3cret-bob')?.id).toBe('bob');
  });

  it('rejects wrong, empty, and undefined secrets', () => {
    expect(store.verify('s3cret-eve')).toBeUndefined();
    expect(store.verify('')).toBeUndefined();
    expect(store.verify(undefined)).toBeUndefined();
    expect(store.verify('S3CRET-ALICE')).toBeUndefined();
  });
});

describe('keyFingerprint', () => {
  it('is stable, short, and does not contain the secret', () => {
    const f1 = keyFingerprint('s3cret-alice');
    const f2 = keyFingerprint('s3cret-alice');
    expect(f1).toBe(f2);
    expect(f1).toHaveLength(8);
    expect(f1).not.toContain('s3cret');
    expect(keyFingerprint('s3cret-bob')).not.toBe(f1);
  });
});
