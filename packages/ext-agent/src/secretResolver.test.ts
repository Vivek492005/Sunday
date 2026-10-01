// Tests for the Part A MCP secret plumbing: key collection from mcp.json
// text, env-name mapping parity with sundayd, SecretStorage-backed
// resolution, and the pre-resolution env builder.
import { describe, expect, it, vi } from 'vitest';
import {
  VscodeSecretResolver,
  buildSecretEnv,
  collectSecretKeys,
  secretEnvName,
  type SecretStore,
} from './secretResolver.js';

function makeStore(values: Record<string, string> = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(values));
  return {
    data,
    get: async (k: string) => data.get(k),
    store: async (k: string, v: string) => {
      data.set(k, v);
    },
    delete: async (k: string) => {
      data.delete(k);
    },
  };
}

describe('collectSecretKeys', () => {
  it('finds secret:<key> and ${secret:<key>} refs, deduplicated', () => {
    const text = JSON.stringify({
      servers: {
        a: { env: { TOKEN: 'secret:github-token', OTHER: '${secret:other.key}' } },
        b: { env: { AGAIN: 'secret:github-token' } },
      },
    });
    expect(collectSecretKeys(text)).toEqual(['github-token', 'other.key']);
  });

  it('returns [] when no refs exist', () => {
    expect(collectSecretKeys('{"mcpServers":{}}')).toEqual([]);
  });
});

describe('secretEnvName', () => {
  it('maps dots/dashes to underscores with the SUNDAY_MCP_SECRET_ prefix', () => {
    expect(secretEnvName('github-token')).toBe('SUNDAY_MCP_SECRET_github_token');
    expect(secretEnvName('my.api_key')).toBe('SUNDAY_MCP_SECRET_my_api_key');
  });
});

describe('VscodeSecretResolver', () => {
  it('resolves stored keys and errors clearly on missing ones', async () => {
    const r = new VscodeSecretResolver(makeStore({ 'github-token': 'abc' }));
    await expect(r.resolve('github-token')).resolves.toBe('abc');
    await expect(r.resolve('missing')).rejects.toThrow(/not in SecretStorage/);
  });
});

describe('buildSecretEnv', () => {
  const userConfig = JSON.stringify({ servers: { a: { env: { T: 'secret:user-key' } } } });
  const wsConfig = JSON.stringify({ servers: { b: { env: { T: 'secret:ws-key' }, U: '${secret:shared}' } } });

  it('merges keys from user + workspace configs and resolves them', async () => {
    const readFile = vi.fn(async (p: string) =>
      p.includes('user') ? userConfig : p.includes('ws') ? wsConfig : undefined,
    );
    const env = await buildSecretEnv(
      readFile,
      '/user/mcp.json',
      '/ws/mcp.json',
      new VscodeSecretResolver(makeStore({ 'user-key': 'u', 'ws-key': 'w', shared: 's' })),
    );
    expect(env).toEqual({
      SUNDAY_MCP_SECRET_user_key: 'u',
      SUNDAY_MCP_SECRET_ws_key: 'w',
      SUNDAY_MCP_SECRET_shared: 's',
    });
  });

  it('skips missing secrets and tolerates unreadable files', async () => {
    const logs: string[] = [];
    const env = await buildSecretEnv(
      async () => userConfig,
      '/user/mcp.json',
      undefined,
      new VscodeSecretResolver(makeStore({})),
      (m) => logs.push(m),
    );
    expect(env).toEqual({});
    expect(logs.some((m) => m.includes('user-key'))).toBe(true);
  });
});
