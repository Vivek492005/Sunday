/**
 * S4: secret pattern coverage — Groq/OpenRouter keys, JWTs, compound env
 * names, high-entropy catch-all.
 */
import { describe, expect, it } from 'vitest';
import { assertNoSecrets, redactSecrets, SecretRefusedError } from './secrets.js';

describe('S4: new secret patterns', () => {
  it('detects Groq keys', () => {
    expect(() => assertNoSecrets('GROQ_API_KEY=gsk_abc123XYZ456')).toThrow(SecretRefusedError);
  });

  it('detects OpenRouter keys', () => {
    expect(() => assertNoSecrets('key=sk-or-v1-abc123def456')).toThrow(SecretRefusedError);
  });

  it('detects OpenAI project keys', () => {
    expect(() => assertNoSecrets('sk-proj-abc123XYZ-_456')).toThrow(SecretRefusedError);
  });

  it('detects JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(() => assertNoSecrets(`token=${jwt}`)).toThrow(SecretRefusedError);
  });

  it('detects compound env names (FOO_OPENROUTER_API_KEY)', () => {
    expect(() => assertNoSecrets('FOO_OPENROUTER_API_KEY=sk-or-v1-xyz')).toThrow(SecretRefusedError);
    expect(() => assertNoSecrets('MY_SUNDAY_TOKEN=abc123')).toThrow(SecretRefusedError);
  });

  it('redacts all new shapes', () => {
    const out = redactSecrets('OPENROUTER_API_KEY=sk-or-v1-abc123 and GROQ_API_KEY=gsk_xyz789');
    expect(out).not.toContain('sk-or-v1-abc123');
    expect(out).not.toContain('gsk_xyz789');
    expect(out).toContain('[REDACTED:');
  });

  it('does not flag innocent text', () => {
    expect(() => assertNoSecrets('the api key goes here in the docs')).not.toThrow();
    expect(() => assertNoSecrets('keyboard shortcut: ctrl+k')).not.toThrow();
  });
});
