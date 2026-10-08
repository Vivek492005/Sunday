/**
 * Unit tests for `session.ts` (Phase 9.a) — Sunday hosted-gateway session
 * management. Runs under Node's built-in test runner with injected fetch and
 * storage fakes; no `vscode` runtime needed.
 *
 * Run: npm test   (esbuild-bundles this file, then node --test)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GATEWAY_URL,
  GATEWAY_TIMEOUT_MS,
  SECRET_REFRESH_TOKEN,
  SECRET_SESSION_TOKEN,
  SECRET_USER,
  GatewayError,
  SundaySessionManager,
  decodeJwtExp,
  exchangeGoogleToken,
  isJwtFresh,
  refreshSundaySession,
  resolveGatewayUrl,
  type HttpFetch,
  type HttpResponse,
  type SecretStore,
} from './session';

// -- Fakes --------------------------------------------------------------------------

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Craft an unsigned JWT whose payload is `{ exp }` (seconds since epoch). */
function makeJwt(expSeconds: number): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ exp: expSeconds })}.sig`;
}

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;
const pastExp = () => Math.floor(Date.now() / 1000) - 3600;

interface FakeStorage extends SecretStore {
  data: Map<string, string>;
}

function makeStorage(initial: Record<string, string> = {}): FakeStorage {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (k) => data.get(k),
    store: async (k, v) => {
      data.set(k, v);
    },
    delete: async (k) => {
      data.delete(k);
    },
  };
}

interface RecordedCall {
  url: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeFetch(
  handler: (url: string, body: unknown) => HttpResponse | Promise<HttpResponse>,
): HttpFetch & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn: HttpFetch = async (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, body });
    return handler(url, body);
  };
  return Object.assign(fn, { calls });
}

const networkFailure: HttpFetch = async () => {
  throw new Error('fetch failed');
};

const GW = 'https://gw.example.test';

const exchangeBody = (jwt: string) => ({
  session_token: jwt,
  refresh_token: 'refresh-1',
  user: {
    id: 'user-1',
    email: 'user@example.com',
    display_name: 'Test User',
    avatar_url: 'https://example.com/a.png',
  },
});

// -- resolveGatewayUrl ---------------------------------------------------------------

describe('resolveGatewayUrl', () => {
  it('defaults to the hosted gateway', () => {
    assert.equal(resolveGatewayUrl(), DEFAULT_GATEWAY_URL);
    assert.equal(resolveGatewayUrl({}), DEFAULT_GATEWAY_URL);
  });

  it('prefers env over setting over default, and strips trailing slashes', () => {
    assert.equal(
      resolveGatewayUrl({ settingUrl: 'https://setting.example/' }),
      'https://setting.example',
    );
    assert.equal(
      resolveGatewayUrl({
        envUrl: 'https://env.example///',
        settingUrl: 'https://setting.example',
      }),
      'https://env.example',
    );
    assert.equal(resolveGatewayUrl({ envUrl: '   ' }), DEFAULT_GATEWAY_URL);
  });
});

// -- JWT helpers -----------------------------------------------------------------------

describe('decodeJwtExp / isJwtFresh', () => {
  it('decodes exp from a JWT payload', () => {
    assert.equal(decodeJwtExp(makeJwt(12345)), 12345);
  });

  it('returns undefined for malformed or tampered tokens', () => {
    assert.equal(decodeJwtExp('not-a-jwt'), undefined);
    assert.equal(decodeJwtExp('a.b.c'), undefined); // bad base64 payload
    assert.equal(decodeJwtExp(makeJwt(NaN)), undefined);
    // Tampered payload: valid JSON but no numeric exp.
    const tampered = `${b64url({ alg: 'none' })}.${b64url({ sub: 'x' })}.sig`;
    assert.equal(decodeJwtExp(tampered), undefined);
    assert.equal(isJwtFresh(tampered), false);
  });

  it('treats a token as fresh only when >60s of life remains', () => {
    const now = Date.now();
    assert.equal(isJwtFresh(makeJwt(Math.floor(now / 1000) + 3600), now), true);
    assert.equal(isJwtFresh(makeJwt(Math.floor(now / 1000) + 61), now), true);
    assert.equal(isJwtFresh(makeJwt(Math.floor(now / 1000) + 59), now), false);
    assert.equal(isJwtFresh(makeJwt(Math.floor(now / 1000) - 10), now), false);
  });
});

// -- exchangeGoogleToken -----------------------------------------------------------------

describe('exchangeGoogleToken', () => {
  it('POSTs the google access token to /auth/session and returns the pair', async () => {
    const fetch = makeFetch((url) => {
      assert.equal(url, `${GW}/auth/session`);
      return jsonResponse(200, exchangeBody(makeJwt(futureExp())));
    });
    const result = await exchangeGoogleToken(fetch, GW, 'google-token-abc');
    assert.deepEqual(fetch.calls[0].body, { google_access_token: 'google-token-abc' });
    assert.equal(result.refreshToken, 'refresh-1');
    assert.deepEqual(result.user, {
      id: 'user-1',
      email: 'user@example.com',
      display_name: 'Test User',
      avatar_url: 'https://example.com/a.png',
    });
    assert.ok(isJwtFresh(result.sessionToken));
  });

  it('surfaces 401 as a GatewayError with status', async () => {
    const fetch = makeFetch(() => jsonResponse(401, { error: 'invalid_token' }));
    await assert.rejects(exchangeGoogleToken(fetch, GW, 'bad'), (e: unknown) => {
      assert.ok(e instanceof GatewayError);
      assert.equal(e.status, 401);
      assert.equal(e.isNetworkError, false);
      return true;
    });
  });

  it('surfaces network failure as a GatewayError without status', async () => {
    await assert.rejects(exchangeGoogleToken(networkFailure, GW, 'tok'), (e: unknown) => {
      assert.ok(e instanceof GatewayError);
      assert.equal(e.status, undefined);
      assert.equal(e.isNetworkError, true);
      return true;
    });
  });
});

// -- refreshSundaySession ------------------------------------------------------------------

describe('refreshSundaySession', () => {
  it('POSTs the refresh token to /auth/refresh', async () => {
    const fetch = makeFetch(() =>
      jsonResponse(200, {
        session_token: makeJwt(futureExp()),
        refresh_token: 'refresh-2',
      }),
    );
    const pair = await refreshSundaySession(fetch, GW, 'refresh-1');
    assert.equal(fetch.calls[0].url, `${GW}/auth/refresh`);
    assert.deepEqual(fetch.calls[0].body, { refresh_token: 'refresh-1' });
    assert.equal(pair.refreshToken, 'refresh-2');
  });

  it('rejects a 401 refresh as GatewayError(401)', async () => {
    const fetch = makeFetch(() => jsonResponse(401, { error: 'invalid_grant' }));
    await assert.rejects(refreshSundaySession(fetch, GW, 'stale'), (e: unknown) => {
      assert.ok(e instanceof GatewayError && e.status === 401);
      return true;
    });
  });
});

// -- SundaySessionManager --------------------------------------------------------------------

describe('SundaySessionManager.establish', () => {
  it('exchange success stores sessionToken, refreshToken and user', async () => {
    const storage = makeStorage();
    const jwt = makeJwt(futureExp());
    const fetch = makeFetch(() => jsonResponse(200, exchangeBody(jwt)));
    const manager = new SundaySessionManager(storage, GW, undefined, fetch);

    const result = await manager.establish('google-token-abc');
    assert.deepEqual(result, { ok: true });
    assert.equal(storage.data.get(SECRET_SESSION_TOKEN), jwt);
    assert.equal(storage.data.get(SECRET_REFRESH_TOKEN), 'refresh-1');
    assert.deepEqual(JSON.parse(storage.data.get(SECRET_USER) ?? '{}'), {
      id: 'user-1',
      email: 'user@example.com',
      display_name: 'Test User',
      avatar_url: 'https://example.com/a.png',
    });
  });

  it('gateway network failure does NOT throw and leaves no Sunday tokens (Google-only sign-in still succeeds)', async () => {
    const storage = makeStorage();
    const manager = new SundaySessionManager(storage, GW, undefined, networkFailure);

    const result = await manager.establish('google-token-abc');
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /unreachable|failed/i);
    assert.equal(storage.data.get(SECRET_SESSION_TOKEN), undefined);
    assert.equal(storage.data.get(SECRET_REFRESH_TOKEN), undefined);
    assert.equal(storage.data.get(SECRET_USER), undefined);
    // getSundaySession() reports no session so callers fall back to Google-only.
    assert.equal(await manager.getSundaySession(), undefined);
  });

  it('401 on exchange clears tokens and returns ok:false', async () => {
    const storage = makeStorage();
    const fetch = makeFetch(() => jsonResponse(401, { error: 'invalid_token' }));
    const manager = new SundaySessionManager(storage, GW, undefined, fetch);
    const result = await manager.establish('bad-google-token');
    assert.equal(result.ok, false);
    assert.equal(storage.data.size, 0);
  });

  it('best-effort logs out the previous refresh token before exchanging', async () => {
    const storage = makeStorage({
      [SECRET_SESSION_TOKEN]: makeJwt(futureExp()),
      [SECRET_REFRESH_TOKEN]: 'old-refresh',
      [SECRET_USER]: JSON.stringify({ id: 'user-0' }),
    });
    const fetch = makeFetch((url) => {
      if (url.endsWith('/auth/logout')) return jsonResponse(200, { ok: true });
      return jsonResponse(200, exchangeBody(makeJwt(futureExp())));
    });
    const manager = new SundaySessionManager(storage, GW, undefined, fetch);
    await manager.establish('google-token-new');
    const logoutCall = fetch.calls.find((c) => c.url.endsWith('/auth/logout'));
    assert.ok(logoutCall, 'expected a logout call for the old refresh token');
    assert.deepEqual(logoutCall.body, { refresh_token: 'old-refresh' });
    // Logout happens before the new exchange.
    assert.ok(
      fetch.calls.indexOf(logoutCall) < fetch.calls.findIndex((c) => c.url.endsWith('/auth/session')),
    );
    // New tokens replaced the old ones.
    assert.equal(storage.data.get(SECRET_REFRESH_TOKEN), 'refresh-1');
  });

  it('fires the change listener when the session is established', async () => {
    const storage = makeStorage();
    const fetch = makeFetch(() => jsonResponse(200, exchangeBody(makeJwt(futureExp()))));
    let fired = 0;
    const manager = new SundaySessionManager(storage, GW, () => fired++, fetch);
    await manager.establish('tok');
    assert.equal(fired, 1);
  });
});

describe('SundaySessionManager.getSundaySession', () => {
  it('returns the stored session without any fetch when the JWT is fresh', async () => {
    const jwt = makeJwt(futureExp());
    const storage = makeStorage({
      [SECRET_SESSION_TOKEN]: jwt,
      [SECRET_REFRESH_TOKEN]: 'refresh-1',
      [SECRET_USER]: JSON.stringify({ id: 'user-1', email: 'user@example.com' }),
    });
    let calls = 0;
    const fetch: HttpFetch = async () => {
      calls++;
      return jsonResponse(200, {});
    };
    const manager = new SundaySessionManager(storage, GW, undefined, fetch);
    const session = await manager.getSundaySession();
    assert.equal(calls, 0);
    assert.deepEqual(session, {
      sessionToken: jwt,
      user: { id: 'user-1', email: 'user@example.com' },
    });
  });

  it('expired JWT triggers refresh and stores the rotated pair', async () => {
    const storage = makeStorage({
      [SECRET_SESSION_TOKEN]: makeJwt(pastExp()),
      [SECRET_REFRESH_TOKEN]: 'refresh-1',
      [SECRET_USER]: JSON.stringify({ id: 'user-1' }),
    });
    const newJwt = makeJwt(futureExp());
    const fetch = makeFetch(() =>
      jsonResponse(200, { session_token: newJwt, refresh_token: 'refresh-2' }),
    );
    let fired = 0;
    const manager = new SundaySessionManager(storage, GW, () => fired++, fetch);
    const session = await manager.getSundaySession();
    assert.deepEqual(session, { sessionToken: newJwt, user: { id: 'user-1' } });
    assert.equal(storage.data.get(SECRET_SESSION_TOKEN), newJwt);
    assert.equal(storage.data.get(SECRET_REFRESH_TOKEN), 'refresh-2');
    assert.equal(fired, 1);
  });

  it('refresh 401 clears all Sunday tokens and returns undefined', async () => {
    const storage = makeStorage({
      [SECRET_SESSION_TOKEN]: makeJwt(pastExp()),
      [SECRET_REFRESH_TOKEN]: 'replayed-refresh',
      [SECRET_USER]: JSON.stringify({ id: 'user-1' }),
    });
    const fetch = makeFetch(() => jsonResponse(401, { error: 'invalid_grant' }));
    let fired = 0;
    const manager = new SundaySessionManager(storage, GW, () => fired++, fetch);
    assert.equal(await manager.getSundaySession(), undefined);
    assert.equal(storage.data.size, 0);
    assert.ok(fired >= 1, 'change event must fire when tokens are cleared');
  });

  it('refresh network failure keeps stored tokens and returns undefined', async () => {
    const storage = makeStorage({
      [SECRET_SESSION_TOKEN]: makeJwt(pastExp()),
      [SECRET_REFRESH_TOKEN]: 'refresh-1',
      [SECRET_USER]: JSON.stringify({ id: 'user-1' }),
    });
    const manager = new SundaySessionManager(storage, GW, undefined, networkFailure);
    assert.equal(await manager.getSundaySession(), undefined);
    // Tokens are kept so a later retry can still refresh.
    assert.equal(storage.data.get(SECRET_REFRESH_TOKEN), 'refresh-1');
  });

  it('expired JWT with no refresh token clears and returns undefined', async () => {
    const storage = makeStorage({ [SECRET_SESSION_TOKEN]: makeJwt(pastExp()) });
    const fetch = makeFetch(() => jsonResponse(200, {}));
    const manager = new SundaySessionManager(storage, GW, undefined, fetch);
    assert.equal(await manager.getSundaySession(), undefined);
    assert.equal(storage.data.size, 0);
  });

  it('tampered (unparseable-exp) JWT is treated as expired and refreshed', async () => {
    const tampered = `${b64url({ alg: 'none' })}.${b64url({ sub: 'x' })}.sig`;
    const storage = makeStorage({
      [SECRET_SESSION_TOKEN]: tampered,
      [SECRET_REFRESH_TOKEN]: 'refresh-1',
      [SECRET_USER]: JSON.stringify({ id: 'user-1' }),
    });
    const newJwt = makeJwt(futureExp());
    const fetch = makeFetch(() =>
      jsonResponse(200, { session_token: newJwt, refresh_token: 'refresh-2' }),
    );
    const manager = new SundaySessionManager(storage, GW, undefined, fetch);
    const session = await manager.getSundaySession();
    assert.equal(session?.sessionToken, newJwt);
    assert.ok(fetch.calls.some((c) => c.url.endsWith('/auth/refresh')));
  });

  it('returns undefined when nothing is stored', async () => {
    const manager = new SundaySessionManager(makeStorage(), GW, undefined, networkFailure);
    assert.equal(await manager.getSundaySession(), undefined);
  });
});

describe('SundaySessionManager.signOut', () => {
  it('best-effort POSTs /auth/logout then clears everything', async () => {
    const storage = makeStorage({
      [SECRET_SESSION_TOKEN]: makeJwt(futureExp()),
      [SECRET_REFRESH_TOKEN]: 'refresh-1',
      [SECRET_USER]: JSON.stringify({ id: 'user-1' }),
    });
    const fetch = makeFetch((url) => {
      assert.ok(url.endsWith('/auth/logout'));
      return jsonResponse(200, { ok: true });
    });
    let fired = 0;
    const manager = new SundaySessionManager(storage, GW, () => fired++, fetch);
    await manager.signOut();
    assert.deepEqual(fetch.calls[0].body, { refresh_token: 'refresh-1' });
    assert.equal(storage.data.size, 0);
    assert.ok(fired >= 1);
  });

  it('clears everything even when the gateway logout fails', async () => {
    const storage = makeStorage({
      [SECRET_SESSION_TOKEN]: makeJwt(futureExp()),
      [SECRET_REFRESH_TOKEN]: 'refresh-1',
      [SECRET_USER]: JSON.stringify({ id: 'user-1' }),
    });
    const manager = new SundaySessionManager(storage, GW, undefined, networkFailure);
    await manager.signOut(); // must not throw
    assert.equal(storage.data.size, 0);
  });

  it('is a no-op when there is no refresh token', async () => {
    const storage = makeStorage();
    let calls = 0;
    const fetch: HttpFetch = async () => {
      calls++;
      return jsonResponse(200, {});
    };
    const manager = new SundaySessionManager(storage, GW, undefined, fetch);
    await manager.signOut();
    assert.equal(calls, 0);
  });
});

describe('gateway timeout', () => {
  it('uses a ~10s AbortController timeout by default', () => {
    assert.equal(GATEWAY_TIMEOUT_MS, 10_000);
  });

  it('aborts a hanging request and reports it as unreachable', async () => {
    const hanging: HttpFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    await assert.rejects(
      exchangeGoogleToken(hanging, GW, 'tok', 50),
      (e: unknown) => {
        assert.ok(e instanceof GatewayError);
        assert.equal(e.isNetworkError, true);
        assert.match(e.message, /timed out after 50ms/);
        return true;
      },
    );
  });
});
