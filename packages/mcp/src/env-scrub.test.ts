/**
 * S2: MCP stdio child env scrub — children get a minimal env, never the
 * full process.env. One server must not see another server's secrets.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { minimalChildEnv } from './hub.js';

describe('S2: minimalChildEnv', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.SUNDAY_MCP_SECRET_GITHUB = 'super-secret-1';
    process.env.SUNDAY_MCP_SECRET_OTHER = 'super-secret-2';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test';
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = '/home/test';
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('strips SUNDAY_MCP_SECRET_* vars', () => {
    const env = minimalChildEnv();
    expect(env.SUNDAY_MCP_SECRET_GITHUB).toBeUndefined();
    expect(env.SUNDAY_MCP_SECRET_OTHER).toBeUndefined();
  });

  it('strips unrelated secrets like OPENROUTER_API_KEY', () => {
    const env = minimalChildEnv();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('keeps benign basics (PATH, HOME)', () => {
    const env = minimalChildEnv();
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/test');
  });
});
