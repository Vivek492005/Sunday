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
    // Extra test tokens for account-switch limit tests (distinct subs).
    const extraSubs: Record<string, string> = {
      'google-token-2': 'google-sub-456',
      'google-token-3': 'google-sub-789',
    };
    if (token && extraSubs[token]) {
      return json({
        sub: extraSubs[token],
        expires_in: '3599',
        aud: SUNDAY_GOOGLE_CLIENT_ID,
        email: `${extraSubs[token]}@example.com`,
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
    // Extra test tokens for account-switch limit tests.
    const extraUserinfo: Record<string, { sub: string; email: string }> = {
      'google-token-2': { sub: 'google-sub-456', email: 'user2@example.com' },
      'google-token-3': { sub: 'google-sub-789', email: 'user3@example.com' },
    };
    for (const [token, info] of Object.entries(extraUserinfo)) {
      if (auth === `Bearer ${token}`) {
        return json({
          sub: info.sub,
          email: info.email,
          name: info.sub,
          picture: '',
        });
      }
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
  opts: { method?: string; bearer?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Headers; json: unknown; text: string }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
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

    // Files exist, are 0600 (Unix only — Windows has no permission bits), and contain no raw tokens.
    for (const name of ['users.json', 'sessions.json']) {
      const p = join(started.dataDir, name);
      if (process.platform !== 'win32') {
        expect(statSync(p).mode & 0o777).toBe(0o600);
      }
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

describe('account-switch rate limiting', () => {
  const MACHINE = 'machine-abc-123';

  function basicUser(id: string): Parameters<AccountsService['checkAccountSwitchLimit']>[3] {
    return {
      id,
      google_sub: `sub-${id}`,
      email: `${id}@example.com`,
      display_name: id,
      avatar_url: '',
      plan: 'basic',
      created_at: new Date().toISOString(),
    };
  }

  function paidUser(id: string) {
    return { ...basicUser(id), plan: 'pro' as const };
  }

  it('allows the first two distinct accounts', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    expect(svc.checkAccountSwitchLimit(MACHINE, 'google', 'sub-1', basicUser('u1')).allowed).toBe(true);
    svc.recordSignin(MACHINE, 'google', 'sub-1', 'u1');
    expect(svc.checkAccountSwitchLimit(MACHINE, 'google', 'sub-2', basicUser('u2')).allowed).toBe(true);
    svc.recordSignin(MACHINE, 'google', 'sub-2', 'u2');
  });

  it('denies the third distinct account within 24h with retryAfter', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    svc.recordSignin(MACHINE, 'google', 'sub-1', 'u1');
    svc.recordSignin(MACHINE, 'google', 'sub-2', 'u2');
    const check = svc.checkAccountSwitchLimit(MACHINE, 'google', 'sub-3', basicUser('u3'));
    expect(check.allowed).toBe(false);
    expect(check.retryAfterSec).toBeGreaterThan(0);
    expect(check.retryAfterSec).toBeLessThanOrEqual(24 * 3600);
  });

  it('allows re-login with the same account (not counted as a switch)', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    svc.recordSignin(MACHINE, 'google', 'sub-1', 'u1');
    svc.recordSignin(MACHINE, 'google', 'sub-2', 'u2');
    // Same sub signing in again is always allowed.
    expect(svc.checkAccountSwitchLimit(MACHINE, 'google', 'sub-1', basicUser('u1')).allowed).toBe(true);
    expect(svc.checkAccountSwitchLimit(MACHINE, 'google', 'sub-2', basicUser('u2')).allowed).toBe(true);
  });

  it('limits are per-provider: google and microsoft tracked separately', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    svc.recordSignin(MACHINE, 'google', 'g-1', 'u1');
    svc.recordSignin(MACHINE, 'google', 'g-2', 'u2');
    // Microsoft is a separate bucket — still allowed.
    expect(svc.checkAccountSwitchLimit(MACHINE, 'microsoft', 'm-1', basicUser('u3')).allowed).toBe(true);
    // But google is full.
    expect(svc.checkAccountSwitchLimit(MACHINE, 'google', 'g-3', basicUser('u4')).allowed).toBe(false);
  });

  it('prunes entries older than 24h', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    svc.recordSignin(MACHINE, 'google', 'sub-1', 'u1');
    svc.recordSignin(MACHINE, 'google', 'sub-2', 'u2');
    // Backdate the entries beyond the window by editing the persisted file.
    const dataDir = (svc as unknown as { dataDir: string }).dataDir;
    void dataDir;
    // Simulate ageing by re-creating the service with a manipulated log.
    const svc2 = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    const old = Date.now() - 25 * 3600 * 1000;
    (svc2 as unknown as { signinLog: unknown[] }).signinLog = [
      { machineId: MACHINE, provider: 'google', sub: 'sub-1', userId: 'u1', at: old },
      { machineId: MACHINE, provider: 'google', sub: 'sub-2', userId: 'u2', at: old },
    ];
    // Old entries are pruned on check — a new account is allowed.
    expect(svc2.checkAccountSwitchLimit(MACHINE, 'google', 'sub-3', basicUser('u3')).allowed).toBe(true);
  });

  it('paid users bypass the limit', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    svc.recordSignin(MACHINE, 'google', 'sub-1', 'u1');
    svc.recordSignin(MACHINE, 'google', 'sub-2', 'u2');
    expect(svc.checkAccountSwitchLimit(MACHINE, 'google', 'sub-3', paidUser('u3')).allowed).toBe(true);
    expect(svc.checkAccountSwitchLimit(MACHINE, 'google', 'sub-9', paidUser('u9')).allowed).toBe(true);
  });

  it('missing machineId skips the check (backward compat)', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    for (let i = 0; i < 5; i++) {
      expect(
        svc.checkAccountSwitchLimit(undefined, 'google', `sub-${i}`, basicUser(`u${i}`)).allowed,
      ).toBe(true);
    }
  });

  it('clearSigninLog removes a machine\'s entries (admin support)', () => {
    const svc = new AccountsService(SESSION_SECRET, { dataDir: freshDataDir() });
    svc.recordSignin(MACHINE, 'google', 'sub-1', 'u1');
    svc.recordSignin(MACHINE, 'google', 'sub-2', 'u2');
    svc.recordSignin('other-machine', 'google', 'sub-9', 'u9');
    expect(svc.clearSigninLog(MACHINE)).toBe(2);
    // Machine is clear — new account allowed again.
    expect(svc.checkAccountSwitchLimit(MACHINE, 'google', 'sub-3', basicUser('u3')).allowed).toBe(true);
    // Other machine untouched.
    expect(svc.clearSigninLog('other-machine')).toBe(1);
    expect(svc.clearSigninLog('nonexistent')).toBe(0);
  });

  it('isPaidPlan: smart/pro bypass, basic does not', async () => {
    const { isPaidPlan } = await import('./accounts.js');
    expect(isPaidPlan('smart')).toBe(true);
    expect(isPaidPlan('pro')).toBe(true);
    expect(isPaidPlan('basic')).toBe(false);
    expect(isPaidPlan(undefined)).toBe(false);
  });
});

describe('POST /auth/session account-switch limit (endpoint)', () => {
  let started: Started | undefined;

  afterEach(async () => {
    await started?.server.close();
    started = undefined;
  });

  it('429 with account_switch_limit on the third distinct account from one machine', async () => {
    started = await start(baseConfig());
    const machineId = 'machine-limit-test';
    const signin = (token: string) =>
      req(started!.base, '/auth/session', {
        method: 'POST',
        body: { google_access_token: token, machine_id: machineId },
      });

    expect((await signin(GOOGLE_TOKEN)).status).toBe(200);
    expect((await signin('google-token-2')).status).toBe(200);
    // Third distinct account → 429.
    const r3 = await signin('google-token-3');
    expect(r3.status).toBe(429);
    const body = r3.json as { error: { code: string }; retryAfter?: number };
    expect(body.error.code).toBe('account_switch_limit');
    expect(typeof body.retryAfter).toBe('number');
    expect(body.retryAfter).toBeGreaterThan(0);

    // Re-login with an existing account still works (not a switch).
    expect((await signin(GOOGLE_TOKEN)).status).toBe(200);
  });

  it('no machine_id → no limit (backward compat)', async () => {
    started = await start(baseConfig());
    const signin = (token: string) =>
      req(started!.base, '/auth/session', {
        method: 'POST',
        body: { google_access_token: token },
      });
    expect((await signin(GOOGLE_TOKEN)).status).toBe(200);
    expect((await signin('google-token-2')).status).toBe(200);
    expect((await signin('google-token-3')).status).toBe(200);
  });

  it('POST /admin/signin-log/clear resets the limit (admin key)', async () => {
    started = await start(baseConfig({ adminKey: 'test-admin-key' }));
    const machineId = 'machine-clear-test';
    const signin = (token: string) =>
      req(started!.base, '/auth/session', {
        method: 'POST',
        body: { google_access_token: token, machine_id: machineId },
      });
    await signin(GOOGLE_TOKEN);
    await signin('google-token-2');
    expect((await signin('google-token-3')).status).toBe(429);

    // Admin clears the machine's log.
    const clear = await req(started.base, '/admin/signin-log/clear', {
      method: 'POST',
      body: { machineId },
      headers: { 'x-admin-key': 'test-admin-key' },
    });
    expect(clear.status).toBe(200);
    expect((clear.json as { cleared: number }).cleared).toBe(2);

    // Now the third account works.
    expect((await signin('google-token-3')).status).toBe(200);
  });

  it('POST /admin/signin-log/clear: 403 without admin key', async () => {
    started = await start(baseConfig({ adminKey: 'test-admin-key' }));
    const r = await req(started.base, '/admin/signin-log/clear', {
      method: 'POST',
      body: { machineId: 'x' },
    });
    expect(r.status).toBe(403);
  });
});
