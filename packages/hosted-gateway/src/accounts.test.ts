import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, statSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsService, SUNDAY_GOOGLE_CLIENT_ID } from './accounts.js';
import type { HostedGatewayConfig } from './config.js';
import { HostedGatewayServer } from './server.js';

const SESSION_SECRET = 'test-session-secret-not-for-production';
const GOOGLE_TOKEN = 'valid-google-token';

const EXACT_ENTITLEMENTS = {
  plan: 'basic',
  entitlements: {
    'managed_models.enabled': true,
    'managed_models.daily_requests': 200,
    'orchestration.max_feature_agents': 1,
    'orchestration.parallel': false,
    'browser_agent.enabled': false,
    'browser_agent.daily_sessions': 0,
    'codebase_index.max_repo_mb': 100,
    'autocomplete.managed_route': false,
    'scheduler.priority_class': 'standard',
    'support.tier': 'community',
  },
} as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mocked Google (no network in tests): only GOOGLE_TOKEN verifies. */
async function mockGoogleFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.startsWith('https://www.googleapis.com/oauth2/v3/tokeninfo')) {
    const token = new URL(url).searchParams.get('access_token');
    if (token === GOOGLE_TOKEN) {
      return json({
        sub: 'google-sub-123',
        expires_in: '3599',
        aud: SUNDAY_GOOGLE_CLIENT_ID,
        email: 'dev@example.com',
      });
    }
    if (token === 'expired-google-token') {
      return json({ sub: 'google-sub-123', expires_in: '0', aud: SUNDAY_GOOGLE_CLIENT_ID });
    }
    return json({ error: 'invalid_token' }, 400);
  }
  if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
    const auth = new Headers(init?.headers).get('authorization');
    if (auth === `Bearer ${GOOGLE_TOKEN}`) {
      return json({
        sub: 'google-sub-123',
        email: 'dev@example.com',
        name: 'Dev User',
        picture: 'https://example.com/pic.png',
      });
    }
    return json({ error: 'invalid_token' }, 401);
  }
  return json({ error: 'unexpected url' }, 500);
}

function signJwt(secret: string, payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const s = createHmac('sha256', secret).update(`${h}.${p}`, 'utf8').digest('base64url');
  return `${h}.${p}.${s}`;
}

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'sunday-accounts-test-'));
}

function baseConfig(overrides: Partial<HostedGatewayConfig> = {}): HostedGatewayConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    keys: [{ id: 'tester', secret: 'test-secret-1' }],
    requestsPerMinute: 1000,
    tokensPerMinute: 1_000_000,
    maxBodyBytes: 64 * 1024,
    maxMessages: 50,
    maxMessageChars: 10_000,
    maxTokensCap: 256,
    allowedModels: [],
    ipAllowlist: [],
    auditLog: '/dev/null',
    upstreamTimeoutMs: 10_000,
    socialAuth: false,
    oauthProviders: ['github', 'google', 'microsoft'],
    dailyQuota: 200,
    sessionSecret: SESSION_SECRET,
    ...overrides,
  };
}

interface Started {
  server: HostedGatewayServer;
  base: string;
  dataDir: string;
}

async function start(config: HostedGatewayConfig): Promise<Started> {
  const dataDir = freshDataDir();
  // Phase 9.b: the server loads plans.json once at startup (fail closed),
  // so test servers seed the committed templates into their tmp data dir.
  copyFileSync(new URL('../data/plans.json', import.meta.url), join(dataDir, 'plans.json'));
  const server = new HostedGatewayServer(config, {
    dataDir,
    accountsFetch: mockGoogleFetch as typeof fetch,
  });
  await server.listen();
  const a = server.address();
  return { server, base: `http://${a.host}:${a.port}`, dataDir };
}

async function req(
  base: string,
  path: string,
  opts: { method?: string; bearer?: string; body?: unknown; rawBody?: string } = {},
): Promise<{ status: number; headers: Headers; json: unknown; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers, body });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // leave as null
  }
  return { status: res.status, headers: res.headers, json: parsed, text };
}

async function signIn(base: string): Promise<{ session: string; refresh: string; userId: string }> {
  const r = await req(base, '/auth/session', {
    method: 'POST',
    body: { google_access_token: GOOGLE_TOKEN },
  });
  expect(r.status).toBe(200);
  const j = r.json as { session_token: string; refresh_token: string; user: { id: string } };
  return { session: j.session_token, refresh: j.refresh_token, userId: j.user.id };
}

describe('AccountsService (unit)', () => {
  it('issues and verifies a session JWT', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    const jwt = svc.issueSessionToken('u_abc');
    expect(svc.verifySessionToken(jwt)).toBe('u_abc');
  });

  it('rejects an expired JWT', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    const past = Math.floor(Date.now() / 1000) - 7200;
    const jwt = signJwt(SESSION_SECRET, { sub: 'u_abc', iat: past, exp: past + 3600 });
    expect(svc.verifySessionToken(jwt)).toBeUndefined();
  });

  it('rejects a tampered JWT', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    const jwt = svc.issueSessionToken('u_abc');
    const [h, p, s] = jwt.split('.');
    // Flip one char in the payload part (signature stays the attacker's old one).
    const tampered = `${h}.${p!.slice(0, -1)}${p!.slice(-1) === 'A' ? 'B' : 'A'}.${s}`;
    expect(svc.verifySessionToken(tampered)).toBeUndefined();
  });

  it('rejects a JWT signed with the wrong secret', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    const nowS = Math.floor(Date.now() / 1000);
    const jwt = signJwt('wrong-secret', { sub: 'u_abc', iat: nowS, exp: nowS + 3600 });
    expect(svc.verifySessionToken(jwt)).toBeUndefined();
  });

  it('rejects malformed tokens', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    expect(svc.verifySessionToken(undefined)).toBeUndefined();
    expect(svc.verifySessionToken('not-a-jwt')).toBeUndefined();
    expect(svc.verifySessionToken('a.b')).toBeUndefined();
    // 'none' algorithm must never be accepted, even unsigned.
    const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
    const p = Buffer.from(JSON.stringify({ sub: 'u_abc', exp: 9_999_999_999 }), 'utf8').toString('base64url');
    expect(svc.verifySessionToken(`${h}.${p}.`)).toBeUndefined();
  });
});

describe('accounts endpoints', () => {
  let started: Started | undefined;

  afterEach(async () => {
    await started?.server.close();
    started = undefined;
  });

  it('POST /auth/session issues tokens, persists user + session (0600 files)', async () => {
    started = await start(baseConfig());
    const r = await req(started.base, '/auth/session', {
      method: 'POST',
      body: { google_access_token: GOOGLE_TOKEN },
    });
    expect(r.status).toBe(200);
    const j = r.json as {
      session_token: string;
      refresh_token: string;
      user: { id: string; email: string; display_name: string; avatar_url: string };
      entitlements: unknown;
    };
    expect(j.session_token.split('.')).toHaveLength(3);
    expect(typeof j.refresh_token).toBe('string');
    expect(j.user.id).toMatch(/^u_[0-9a-f]{16}$/);
    expect(j.user.email).toBe('dev@example.com');
    expect(j.user.display_name).toBe('Dev User');
    expect(j.user.avatar_url).toBe('https://example.com/pic.png');
    expect(j.entitlements).toEqual(EXACT_ENTITLEMENTS);

    // Same Google account signs in again -> same user id, no duplicate.
    const r2 = await req(started.base, '/auth/session', {
      method: 'POST',
      body: { google_access_token: GOOGLE_TOKEN },
    });
    expect(r2.status).toBe(200);
    expect((r2.json as { user: { id: string } }).user.id).toBe(j.user.id);

    // Files exist, are 0600, and contain no raw tokens.
    for (const name of ['users.json', 'sessions.json']) {
      const p = join(started.dataDir, name);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      const raw = readFileSync(p, 'utf8');
      expect(raw).not.toContain(j.refresh_token);
    }
    expect(readFileSync(join(started.dataDir, 'users.json'), 'utf8')).toContain('google-sub-123');
  });

  it('POST /auth/session: 400 on missing token, 401 on invalid/expired Google token', async () => {
    started = await start(baseConfig());
    expect((await req(started.base, '/auth/session', { method: 'POST', body: {} })).status).toBe(400);
    expect(
      (await req(started.base, '/auth/session', { method: 'POST', body: { google_access_token: 'bogus' } })).status,
    ).toBe(401);
    expect(
      (
        await req(started.base, '/auth/session', {
          method: 'POST',
          body: { google_access_token: 'expired-google-token' },
        })
      ).status,
    ).toBe(401);
  });

  it('full lifecycle: issue -> verify -> rotate -> revoke', async () => {
    started = await start(baseConfig());
    const { session, refresh } = await signIn(started.base);

    // Verify: session JWT authenticates on a protected route (middleware fallback).
    expect((await req(started.base, '/v1/models', { bearer: session })).status).toBe(200);

    // Rotate.
    const r = await req(started.base, '/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refresh },
    });
    expect(r.status).toBe(200);
    const rotated = r.json as { session_token: string; refresh_token: string };
    // Session JWTs have second-resolution iat/exp, so a same-second rotation
    // legitimately yields an identical JWT — the meaningful check is validity.
    expect(
      (await req(started.base, '/me/entitlements', { bearer: rotated.session_token })).status,
    ).toBe(200);
    expect(rotated.refresh_token).not.toBe(refresh);

    // Replay of the old refresh token -> 401.
    const replay = await req(started.base, '/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refresh },
    });
    expect(replay.status).toBe(401);

    // The new refresh token works once more.
    const r2 = await req(started.base, '/auth/refresh', {
      method: 'POST',
      body: { refresh_token: rotated.refresh_token },
    });
    expect(r2.status).toBe(200);
    const newest = (r2.json as { refresh_token: string }).refresh_token;

    // Revoke via logout; then the token is dead, but logout stays 200 (idempotent).
    const lo = await req(started.base, '/auth/logout', {
      method: 'POST',
      body: { refresh_token: newest },
    });
    expect(lo.status).toBe(200);
    expect((lo.json as { ok: boolean }).ok).toBe(true);
    expect(
      (await req(started.base, '/auth/refresh', { method: 'POST', body: { refresh_token: newest } })).status,
    ).toBe(401);
    expect(
      (await req(started.base, '/auth/logout', { method: 'POST', body: { refresh_token: newest } })).status,
    ).toBe(200);
  });

  it('logout with a session JWT revokes ALL of that user\'s refresh tokens', async () => {
    started = await start(baseConfig());
    const a = await signIn(started.base);
    const b = await signIn(started.base);
    expect(a.userId).toBe(b.userId);

    const lo = await req(started.base, '/auth/logout', { method: 'POST', bearer: b.session });
    expect(lo.status).toBe(200);
    for (const tok of [a.refresh, b.refresh]) {
      expect(
        (await req(started.base, '/auth/refresh', { method: 'POST', body: { refresh_token: tok } })).status,
      ).toBe(401);
    }
  });

  it('POST /auth/refresh: 401 on unknown token, 400 on missing body', async () => {
    started = await start(baseConfig());
    expect(
      (await req(started.base, '/auth/refresh', { method: 'POST', body: { refresh_token: 'nope' } })).status,
    ).toBe(401);
    expect((await req(started.base, '/auth/refresh', { method: 'POST', body: {} })).status).toBe(400);
  });

  it('POST /auth/logout is idempotent for unknown tokens', async () => {
    started = await start(baseConfig());
    const r = await req(started.base, '/auth/logout', {
      method: 'POST',
      body: { refresh_token: 'never-issued' },
    });
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    // Empty body also fine.
    expect((await req(started.base, '/auth/logout', { method: 'POST' })).status).toBe(200);
  });

  it('GET /me/entitlements returns the full plan view (plan + entitlements kept for 9.a clients)', async () => {
    started = await start(baseConfig());
    const { session, userId } = await signIn(started.base);
    const r = await req(started.base, '/me/entitlements', { bearer: session });
    expect(r.status).toBe(200);
    const j = r.json as Record<string, unknown>;
    expect(j.user_id).toBe(userId);
    expect(j.plan).toBe('basic');
    expect(j.status).toBe('active');
    expect(j.renews_at).toBeNull();
    expect(j.entitlements).toEqual(EXACT_ENTITLEMENTS.entitlements);
    expect(typeof j.cached_at).toBe('string');
    expect(typeof j.valid_until).toBe('string');
    expect(Date.parse(j.valid_until as string)).toBeGreaterThan(Date.parse(j.cached_at as string));
  });

  it('GET /me/entitlements: 401 without auth, with API key, with bad/expired/tampered JWT', async () => {
    started = await start(baseConfig());
    const { session } = await signIn(started.base);
    expect((await req(started.base, '/me/entitlements')).status).toBe(401);
    // A gateway API key is NOT a session: 401 per contract.
    expect((await req(started.base, '/me/entitlements', { bearer: 'test-secret-1' })).status).toBe(401);
    expect((await req(started.base, '/me/entitlements', { bearer: 'garbage' })).status).toBe(401);

    const nowS = Math.floor(Date.now() / 1000);
    const expired = signJwt(SESSION_SECRET, { sub: 'u_x', iat: nowS - 7200, exp: nowS - 3600 });
    expect((await req(started.base, '/me/entitlements', { bearer: expired })).status).toBe(401);

    const wrongSecret = signJwt('wrong-secret', { sub: 'u_x', iat: nowS, exp: nowS + 3600 });
    expect((await req(started.base, '/me/entitlements', { bearer: wrongSecret })).status).toBe(401);

    const [h, p, s] = session.split('.');
    const tampered = `${h}.${p!.slice(0, -1)}${p!.slice(-1) === 'A' ? 'B' : 'A'}.${s}`;
    expect((await req(started.base, '/me/entitlements', { bearer: tampered })).status).toBe(401);
  });

  it('/auth/* trips the stricter per-IP rate limit (429 + Retry-After)', async () => {
    started = await start(baseConfig());
    let saw429 = false;
    for (let i = 0; i < 25; i++) {
      const r = await req(started.base, '/auth/session', {
        method: 'POST',
        body: { google_access_token: 'bogus' },
      });
      if (r.status === 429) {
        saw429 = true;
        expect(r.headers.get('retry-after')).toBe('60');
        break;
      }
      expect(r.status).toBe(401);
    }
    expect(saw429).toBe(true);
  });

  it('existing auth paths still work (API key on protected routes)', async () => {
    started = await start(baseConfig());
    expect((await req(started.base, '/v1/models', { bearer: 'test-secret-1' })).status).toBe(200);
    expect((await req(started.base, '/v1/models', { bearer: 'wrong' })).status).toBe(401);
  });
});

describe('config: SUNDAY_SESSION_SECRET', () => {
  it('loadConfig fails fast when the session secret is missing', async () => {
    const { loadConfig } = await import('./config.js');
    expect(() =>
      loadConfig({ ...process.env, SUNDAY_HOSTED_KEYS: 'a:b', SUNDAY_SESSION_SECRET: '' }),
    ).toThrow(/session secret/);
  });
});
