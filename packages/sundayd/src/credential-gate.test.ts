import { describe, it, expect } from 'vitest';
import { isCredentialFile, credentialGateReason } from './credential-gate.js';

describe('SEC-10 credential gating', () => {
  it('gates .env files', () => {
    expect(isCredentialFile('.env')).toBe(true);
    expect(isCredentialFile('config/.env.local')).toBe(true);
  });

  it('gates key material', () => {
    expect(isCredentialFile('cert.pem')).toBe(true);
    expect(isCredentialFile('server.key')).toBe(true);
    expect(isCredentialFile('~/.ssh/id_rsa')).toBe(true);
  });

  it('gates credentials.json / secrets.yaml', () => {
    expect(isCredentialFile('credentials.json')).toBe(true);
    expect(isCredentialFile('secrets.yaml')).toBe(true);
  });

  it('does NOT gate ordinary source files', () => {
    expect(isCredentialFile('src/index.ts')).toBe(false);
    expect(isCredentialFile('README.md')).toBe(false);
    expect(isCredentialFile('package.json')).toBe(false);
  });

  it('returns a gating reason for credential files', () => {
    const reason = credentialGateReason('.env');
    expect(reason).toContain('SEC-10');
    expect(reason).toContain('Manual approval required');
  });

  it('returns null for non-credential files', () => {
    expect(credentialGateReason('src/index.ts')).toBeNull();
  });

  it('staged secret: .env content is gated before reaching provider', () => {
    // The gate fires at read time, before redaction (SEC-03) would even run.
    const reason = credentialGateReason('/home/user/project/.env');
    expect(reason).not.toBeNull();
  });
});
