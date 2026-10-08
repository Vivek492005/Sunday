// Tests for usage/gatewayClient.ts: URL resolution, payload validation,
// transport error mapping, session-token lookup. No network, no vscode.
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GATEWAY_URL,
  fetchUsageSnapshot,
  GatewayAuthError,
  GatewayUnreachableError,
  getSessionToken,
  resolveGatewayUrl,
  validateUsageSnapshot,
  type GatewayFetch,
  type UsageSnapshot,
} from './gatewayClient.js';

const good: UsageSnapshot = {
  today: { requests: 3, tokens_in: 100, tokens_out: 50 },
  by_model: [{ model: 'openrouter:llama', requests: 3, tokens: 150 }],
  history_7d: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${i + 1}`, requests: i })),
};

function cfg(values: Record<string, string> = {}) {
  return { get: <T>(key: string, def: T): T => ((values[key] as unknown as T) ?? def) };
}

describe('resolveGatewayUrl', () => {
  it('prefers the sunday.gateway.url setting', () => {
    expect(resolveGatewayUrl(cfg({ 'gateway.url': 'https://gw.example.com/' }), {})).toBe(
      'https://gw.example.com',
    );
  });

  it('falls back to SUNDAY_API_URL then the built-in default', () => {
    expect(resolveGatewayUrl(cfg(), { SUNDAY_API_URL: 'https://env.example.com' })).toBe(
      'https://env.example.com',
    );
    expect(resolveGatewayUrl(cfg(), {})).toBe(DEFAULT_GATEWAY_URL);
  });
});

describe('validateUsageSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    expect(validateUsageSnapshot(good)).toEqual(good);
  });

  it('rejects malformed payloads', () => {
    const bad = [
      null,
      {},
      { ...good, today: { requests: -1, tokens_in: 0, tokens_out: 0 } },
      { ...good, today: { requests: '3', tokens_in: 0, tokens_out: 0 } },
      { ...good, by_model: [{ model: 'x' }] },
      { ...good, history_7d: [{ day: '2026-10-01' }] },
      { ...good, history_7d: 'nope' },
    ];
    for (const b of bad) expect(validateUsageSnapshot(b)).toBeUndefined();
  });
});

function okFetch(payload: unknown): GatewayFetch {
  return async () => ({ ok: true, status: 200, json: async () => payload });
}

describe('fetchUsageSnapshot', () => {
  it('fetches with the session bearer token', async () => {
    const seen: string[] = [];
    const f: GatewayFetch = async (url, init) => {
      seen.push(`${url}|${init?.headers?.authorization}`);
      return { ok: true, status: 200, json: async () => good };
    };
    const s = await fetchUsageSnapshot(f, 'https://gw', 'tok123');
    expect(s.today.requests).toBe(3);
    expect(seen[0]).toBe('https://gw/me/usage|Bearer tok123');
  });

  it('maps 401/403 to GatewayAuthError', async () => {
    for (const status of [401, 403]) {
      const f: GatewayFetch = async () => ({
        ok: false,
        status,
        json: async () => ({}),
      });
      await expect(fetchUsageSnapshot(f, 'https://gw', 'tok')).rejects.toBeInstanceOf(
        GatewayAuthError,
      );
    }
  });

  it('maps network failures to GatewayUnreachableError', async () => {
    const f: GatewayFetch = async () => {
      throw new Error('fetch failed');
    };
    await expect(fetchUsageSnapshot(f, 'https://gw', 'tok')).rejects.toBeInstanceOf(
      GatewayUnreachableError,
    );
  });

  it('rejects malformed payloads and other HTTP errors', async () => {
    await expect(fetchUsageSnapshot(okFetch({ nope: true }), 'https://gw', 'tok')).rejects.toThrow(
      /unexpected shape/,
    );
    const f500: GatewayFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await expect(fetchUsageSnapshot(f500, 'https://gw', 'tok')).rejects.toThrow(/HTTP 500/);
  });

  it('requires a token', async () => {
    await expect(fetchUsageSnapshot(okFetch(good), 'https://gw', '')).rejects.toBeInstanceOf(
      GatewayAuthError,
    );
  });
});

describe('getSessionToken', () => {
  it('prefers the auth extension export', async () => {
    const t = await getSessionToken({
      getExtensionExports: () => ({ getSundaySessionToken: async () => 'ext-token' }),
      secretGet: async () => 'secret-token',
    });
    expect(t).toBe('ext-token');
  });

  it('falls back to SecretStorage', async () => {
    const secretGet = vi.fn(async () => 'secret-token');
    const t = await getSessionToken({
      getExtensionExports: () => undefined,
      secretGet,
    });
    expect(t).toBe('secret-token');
    expect(secretGet).toHaveBeenCalledWith('sunday.sessionToken');
  });

  it('returns undefined when signed out, never throws', async () => {
    const t = await getSessionToken({
      getExtensionExports: () => {
        throw new Error('boom');
      },
      secretGet: async () => undefined,
    });
    expect(t).toBeUndefined();
  });
});
