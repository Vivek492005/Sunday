// Tests for the separate admin login gateway (POST /admin/login).
//
// Covers: allowlist parsing, admin OAuth login (google + microsoft),
// fail-closed when unconfigured, 403 without info leakage, JWT claims
// (role/iss/expiry), requireAdmin, refresh rotation + replay, logout
// revocation, /admin/me, audit logging (hashed emails only), the
// accounts.ts issuer guard, server-level integration (login/me/logout,
// 5/min rate limit, account-switch bypass, quota bypass).
import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdminService,
  parseAdminEmails,
  emailHash,
  verifyMicrosoftToken,
  ADMIN_TOKEN_ISSUER,
  ADMIN_PERMISSIONS,
} from './admin-auth.js';
import { AccountsService } from './accounts.js';
import { HostedGatewayServer } from './server.js';
import type { HostedGatewayConfig } from './config.js';
import { MockChatProvider, ProviderRegistry, Router, type ChatChunk } from '@sunday/gateway';

const SECRET = 'test-admin-secret-not-for-production';
const ADMIN_EMAIL = 'vivekbartwal158@gmail.com';
const PLANS_FIXTURE = new URL('../data/plans.json', import.meta.url);

const GOOGLE_ADMIN_TOKEN = 'test-google-admin-token';
const GOOGLE_USER_A_TOKEN = 'test-google-user-a-token';
const GOOGLE_USER_B_TOKEN = 'test-google-user-b-token';
const GOOGLE_USER_C_TOKEN = 'test-google-user-c-token';
const MS_ADMIN_TOKEN = 'test-ms-admin-token';

const GOOGLE_IDENTITIES: Record<string, { sub: string; email: string; name: string }> = {
  [GOOGLE_ADMIN_TOKEN]: { sub: 'google-sub-admin', email: ADMIN_EMAIL, name: 'Founder' },
  [GOOGLE_USER_A_TOKEN]: { sub: 'google-sub-a', email: 'user-a@example.com', name: 'User A' },
  [GOOGLE_USER_B_TOKEN]: { sub: 'google-sub-b', email: 'user-b@example.com', name: 'User B' },
  [GOOGLE_USER_C_TOKEN]: { sub: 'google-sub-c', email: 'user-c@example.com', name: 'User C' },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mocked OAuth providers (no network in tests). */
async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
  if (url.startsWith('https://www.googleapis.com/oauth2/v3/tokeninfo')) {
    const token = new URL(url).searchParams.get('access_token');
    const id = token ? GOOGLE_IDENTITIES[token] : undefined;
    if (id) return json({ sub: id.sub, expires_in: '3599', aud: 'test-aud', email: id.email });
    return json({ error: 'invalid_token' }, 400);
  }
  if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
    const auth = new Headers(init?.headers).get('authorization');
    const token = auth?.replace(/^Bearer\s+/i, '');
    const id = token ? GOOGLE_IDENTITIES[token] : undefined;
    if (id) return json({ sub: id.sub, email: id.email, name: id.name, picture: '' });
    return json({ error: 'invalid_token' }, 401);
  }
  if (url === 'https://graph.microsoft.com/v1.0/me') {
    const auth = new Headers(init?.headers).get('authorization');
    if (auth === `Bearer ${MS_ADMIN_TOKEN}`) {
      return json({ id: 'ms-id-admin', mail: ADMIN_EMAIL, displayName: 'Founder' });
    }
    return json({ error: 'invalid_token' }, 401);
  }
  return json({ error: 'unexpected url' }, 500);
}

function freshDir(prefix = 'sunday-admin-auth-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Hand-mint an admin JWT (for tamper/expiry tests). */
function mintAdminJwt(
  secret: string,
  claims: Record<string, unknown>,
): string {
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`, 'utf8').digest('base64url');
  return `${h}.${p}.${sig}`;
}

function validAdminClaims(jti: string, email: string, expOffsetSec = 8 * 3600): Record<string, unknown> {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    sub: `admin:${email}`,
    email,
    role: 'admin',
    iss: ADMIN_TOKEN_ISSUER,
    jti,
    iat: nowS,
    exp: nowS + expOffsetSec,
  };
}

// ---------------------------------------------------------------------------
// Unit: allowlist parsing + email hashing
// ---------------------------------------------------------------------------

describe('parseAdminEmails', () => {
  it('parses comma-separated emails, trimming and lowercasing', () => {
    expect(parseAdminEmails('A@x.com, b@Y.com ,,')).toEqual(['a@x.com', 'b@y.com']);
  });
  it('returns [] for unset/empty (fail closed)', () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails('')).toEqual([]);
    expect(parseAdminEmails(' , ')).toEqual([]);
  });
});

describe('emailHash', () => {
  it('is deterministic, case-insensitive, and never contains the plaintext', () => {
    const h1 = emailHash(ADMIN_EMAIL);
    const h2 = emailHash(ADMIN_EMAIL.toUpperCase());
    expect(h1).toBe(h2);
    expect(h1).not.toContain('vivek');
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Unit: AdminService login / verify / refresh / logout / me
// ---------------------------------------------------------------------------

describe('AdminService', () => {
  it('logs in an allowlisted google email and issues a role=admin JWT', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    const res = await svc.login(GOOGLE_ADMIN_TOKEN, 'google', '1.2.3.4');
    expect(res.admin).toEqual({ email: ADMIN_EMAIL, role: 'admin' });
    expect(typeof res.admin_token).toBe('string');
    expect(typeof res.refresh_token).toBe('string');
    const verified = svc.verifyAdminToken(res.admin_token);
    expect(verified?.email).toBe(ADMIN_EMAIL);
  });

  it('is case-insensitive on the allowlist', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL.toUpperCase()], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    const res = await svc.login(GOOGLE_ADMIN_TOKEN, 'google', '1.2.3.4');
    expect(res.admin.email).toBe(ADMIN_EMAIL);
  });

  it('logs in via microsoft', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    const res = await svc.login(MS_ADMIN_TOKEN, 'microsoft', '1.2.3.4');
    expect(res.admin.email).toBe(ADMIN_EMAIL);
  });

  it('rejects non-allowlisted emails with 403 and no info leakage', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    try {
      await svc.login(GOOGLE_USER_A_TOKEN, 'google', '1.2.3.4');
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(403);
      expect(err.code).toBe('not_admin');
      expect(err.message).not.toContain(ADMIN_EMAIL);
      expect(err.message).not.toContain('vivek');
    }
  });

  it('rejects invalid OAuth tokens with 401', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    try {
      await svc.login('bogus-token', 'google', '1.2.3.4');
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(401);
    }
  });

  it('fails closed when SUNDAY_ADMIN_EMAILS is unset', async () => {
    const svc = new AdminService(SECRET, [], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    expect(svc.isConfigured()).toBe(false);
    try {
      await svc.login(GOOGLE_ADMIN_TOKEN, 'google', '1.2.3.4');
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(403);
      expect(err.code).toBe('admin_not_configured');
    }
  });

  it('rejects unknown providers with 400', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    try {
      await svc.login(GOOGLE_ADMIN_TOKEN, 'github', '1.2.3.4');
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(400);
    }
  });

  it('verifyAdminToken rejects wrong-secret, tampered, and expired tokens', async () => {
    const dir = freshDir();
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: dir, fetchFn: mockFetch as typeof fetch });
    const good = await svc.login(GOOGLE_ADMIN_TOKEN, 'google', '1.2.3.4');

    // Wrong secret.
    const wrongSecret = mintAdminJwt('other-secret', validAdminClaims('jti-x', ADMIN_EMAIL));
    expect(svc.verifyAdminToken(wrongSecret)).toBeUndefined();

    // Tampered role claim.
    const parts = good.admin_token.split('.');
    const badRole = mintAdminJwt(SECRET, { ...validAdminClaims('jti-y', ADMIN_EMAIL), role: 'user' });
    expect(svc.verifyAdminToken(badRole)).toBeUndefined();
    void parts;

    // Wrong issuer.
    const badIss = mintAdminJwt(SECRET, { ...validAdminClaims('jti-z', ADMIN_EMAIL), iss: 'other' });
    expect(svc.verifyAdminToken(badIss)).toBeUndefined();

    // Expired (hand-minted past exp; crypto checks run before the lookup).
    const expired = mintAdminJwt(SECRET, validAdminClaims('jti-e', ADMIN_EMAIL, -10));
    expect(svc.verifyAdminToken(expired)).toBeUndefined();

    // Malformed.
    expect(svc.verifyAdminToken('not-a-token')).toBeUndefined();
    expect(svc.verifyAdminToken(undefined)).toBeUndefined();
  });

  it('requireAdmin returns email for valid tokens and throws 401 otherwise', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    const { admin_token } = await svc.login(GOOGLE_ADMIN_TOKEN, 'google', '1.2.3.4');
    expect(svc.requireAdmin(admin_token)).toBe(ADMIN_EMAIL);
    for (const bad of ['bogus', undefined]) {
      try {
        svc.requireAdmin(bad);
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.status).toBe(401);
        expect(err.code).toBe('admin_unauthorized');
      }
    }
  });

  it('refresh rotation invalidates the old refresh token (no replay)', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    const first = await svc.login(GOOGLE_ADMIN_TOKEN, 'google', '1.2.3.4');
    const second = svc.rotateAdminRefresh(first.refresh_token);
    expect(typeof second.admin_token).toBe('string');
    expect(svc.verifyAdminToken(second.admin_token)?.email).toBe(ADMIN_EMAIL);
    try {
      svc.rotateAdminRefresh(first.refresh_token);
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(401);
      expect(err.code).toBe('invalid_refresh_token');
    }
  });

  it('logout revokes the access session immediately', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    const { admin_token, refresh_token } = await svc.login(GOOGLE_ADMIN_TOKEN, 'google', '1.2.3.4');
    expect(svc.verifyAdminToken(admin_token)).toBeDefined();
    svc.logoutAdmin(refresh_token, admin_token);
    expect(svc.verifyAdminToken(admin_token)).toBeUndefined();
    try {
      svc.rotateAdminRefresh(refresh_token);
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(401);
      expect(err.code).toBe('invalid_refresh_token');
    }
  });

  it('logout is idempotent for unknown tokens', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    expect(() => svc.logoutAdmin('bogus', 'bogus')).not.toThrow();
  });

  it('me returns profile + permissions', async () => {
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: freshDir(), fetchFn: mockFetch as typeof fetch });
    const { admin_token } = await svc.login(GOOGLE_ADMIN_TOKEN, 'google', '1.2.3.4');
    const me = svc.me(admin_token);
    expect(me.email).toBe(ADMIN_EMAIL);
    expect(me.role).toBe('admin');
    expect(me.permissions).toEqual([...ADMIN_PERMISSIONS]);
    expect(typeof me.issued_at).toBe('string');
    expect(typeof me.expires_at).toBe('string');
  });

  it('audits every attempt with hashed (never plaintext) emails', async () => {
    const events: Array<{ emailHash: string; success: boolean; reason?: string }> = [];
    const svc = new AdminService(SECRET, [ADMIN_EMAIL], {
      dataDir: freshDir(),
      fetchFn: mockFetch as typeof fetch,
      onAudit: (e) => events.push(e),
    });
    await svc.login(GOOGLE_ADMIN_TOKEN, 'google', '9.9.9.9');
    try {
      await svc.login(GOOGLE_USER_A_TOKEN, 'google', '9.9.9.9');
    } catch { /* expected */ }
    expect(events.length).toBe(2);
    expect(events[0]!.success).toBe(true);
    expect(events[1]!.success).toBe(false);
    expect(events[1]!.reason).toBe('not_admin');
    expect(events[0]!.emailHash).toBe(emailHash(ADMIN_EMAIL));
    expect(events[1]!.emailHash).toBe(emailHash('user-a@example.com'));
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain(ADMIN_EMAIL);
      expect(JSON.stringify(e)).not.toContain('vivek');
      expect(JSON.stringify(e)).not.toContain('user-a@example.com');
    }
  });

  it('verifyMicrosoftToken extracts email from graph /me', async () => {
    const info = await verifyMicrosoftToken(MS_ADMIN_TOKEN, mockFetch as typeof fetch);
    expect(info?.email).toBe(ADMIN_EMAIL);
    expect(await verifyMicrosoftToken('bogus', mockFetch as typeof fetch)).toBeNull();
  });
});

describe('token-type separation', () => {
  it('user verifySessionToken rejects admin-issuer tokens', async () => {
    const dir = freshDir();
    const accounts = new AccountsService(SECRET, { dataDir: dir });
    const adminSvc = new AdminService(SECRET, [ADMIN_EMAIL], { dataDir: dir, fetchFn: mockFetch as typeof fetch });
    const { admin_token } = await adminSvc.login(GOOGLE_ADMIN_TOKEN, 'google', '1.2.3.4');
    // Same HMAC secret, valid signature — but iss=sunday-admin must never
    // validate as a user session.
    expect(accounts.verifySessionToken(admin_token)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Server integration
// ---------------------------------------------------------------------------

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
    sessionSecret: SECRET,
    adminEmails: [ADMIN_EMAIL],
    ...overrides,
  };
}

function mockRouter(scripts: ChatChunk[][] = [[{ type: 'text-delta', delta: 'hi' }, { type: 'done', finishReason: 'stop' }]]): { router: Router; registry: ProviderRegistry } {
  const registry = new ProviderRegistry();
  registry.register(new MockChatProvider({ id: 'mock', scripts }));
  return { registry, router: new Router(registry, 'mock:mock-model') };
}

interface Started {
  server: HostedGatewayServer;
  base: string;
}

async function start(
  config: HostedGatewayConfig,
  mocked?: { router: Router; registry: ProviderRegistry },
): Promise<Started> {
  const dataDir = mkdtempSync(join(tmpdir(), 'sunday-admin-int-test-'));
  // Seed the committed plans.json templates (server boots fail-closed without it).
  copyFileSync(PLANS_FIXTURE, join(dataDir, 'plans.json'));
  const server = new HostedGatewayServer(config, {
    dataDir,
    accountsFetch: mockFetch as typeof fetch,
    ...(mocked ?? {}),
  });
  await server.listen();
  const a = server.address();
  return { server, base: `http://${a.host}:${a.port}` };
}

async function req(
  base: string,
  path: string,
  opts: { method?: string; bearer?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let j: unknown = null;
  try {
    j = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, json: j, headers: res.headers };
}

describe('POST /admin/login (server)', () => {
  let started: Started | undefined;
  afterEach(async () => {
    await started?.server.close();
    started = undefined;
  });

  it('200s for an allowlisted email with an admin JWT', async () => {
    started = await start(baseConfig());
    const r = await req(started.base, '/admin/login', {
      method: 'POST',
      body: { idToken: GOOGLE_ADMIN_TOKEN, provider: 'google' },
    });
    expect(r.status).toBe(200);
    const j = r.json as { admin_token: string; admin: { email: string; role: string } };
    expect(j.admin).toEqual({ email: ADMIN_EMAIL, role: 'admin' });
    expect(typeof j.admin_token).toBe('string');
  });

  it('403s for non-allowlisted emails without leaking the allowlist', async () => {
    started = await start(baseConfig());
    const r = await req(started.base, '/admin/login', {
      method: 'POST',
      body: { idToken: GOOGLE_USER_A_TOKEN, provider: 'google' },
    });
    expect(r.status).toBe(403);
    const j = r.json as { error: { code: string; message: string } };
    expect(j.error.code).toBe('not_admin');
    expect(JSON.stringify(j)).not.toContain(ADMIN_EMAIL);
  });

  it('fails closed when SUNDAY_ADMIN_EMAILS is unset', async () => {
    started = await start(baseConfig({ adminEmails: [] }));
    const r = await req(started.base, '/admin/login', {
      method: 'POST',
      body: { idToken: GOOGLE_ADMIN_TOKEN, provider: 'google' },
    });
    expect(r.status).toBe(403);
    expect((r.json as { error: { code: string } }).error.code).toBe('admin_not_configured');
  });

  it('401s for invalid OAuth tokens', async () => {
    started = await start(baseConfig());
    const r = await req(started.base, '/admin/login', {
      method: 'POST',
      body: { idToken: 'bogus', provider: 'google' },
    });
    expect(r.status).toBe(401);
  });

  it('rate-limits admin login to 5/min per IP', async () => {
    started = await start(baseConfig());
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const r = await req(started.base, '/admin/login', {
        method: 'POST',
        body: { idToken: 'bogus', provider: 'google' },
      });
      last = r.status;
    }
    expect(last).toBe(429);
  });

  it('GET /admin/me needs a live admin session', async () => {
    started = await start(baseConfig());
    const login = await req(started.base, '/admin/login', {
      method: 'POST',
      body: { idToken: GOOGLE_ADMIN_TOKEN, provider: 'google' },
    });
    const token = (login.json as { admin_token: string }).admin_token;

    const me = await req(started.base, '/admin/me', { bearer: token });
    expect(me.status).toBe(200);
    expect((me.json as { email: string }).email).toBe(ADMIN_EMAIL);
    expect((me.json as { permissions: string[] }).permissions).toContain('admin:bypass:daily-quota');

    const noAuth = await req(started.base, '/admin/me');
    expect(noAuth.status).toBe(401);

    // A regular user session token is NOT an admin session.
    const userLogin = await req(started.base, '/auth/session', {
      method: 'POST',
      body: { google_access_token: GOOGLE_USER_A_TOKEN },
    });
    const userToken = (userLogin.json as { session_token: string }).session_token;
    const userMe = await req(started.base, '/admin/me', { bearer: userToken });
    expect(userMe.status).toBe(401);
  });

  it('POST /admin/logout revokes the session', async () => {
    started = await start(baseConfig());
    const login = await req(started.base, '/admin/login', {
      method: 'POST',
      body: { idToken: GOOGLE_ADMIN_TOKEN, provider: 'google' },
    });
    const { admin_token, refresh_token } = login.json as { admin_token: string; refresh_token: string };
    const out = await req(started.base, '/admin/logout', {
      method: 'POST',
      bearer: admin_token,
      body: { refresh_token },
    });
    expect(out.status).toBe(200);
    const me = await req(started.base, '/admin/me', { bearer: admin_token });
    expect(me.status).toBe(401);
  });

  it('admin login bypasses the account-switch limit (structural)', async () => {
    started = await start(baseConfig());
    const machine = 'machine-xyz';
    // Exhaust the user account-switch limit: 2 accounts OK, 3rd denied.
    for (const tok of [GOOGLE_USER_A_TOKEN, GOOGLE_USER_B_TOKEN]) {
      const r = await req(started.base, '/auth/session', {
        method: 'POST',
        body: { google_access_token: tok, machine_id: machine },
      });
      expect(r.status).toBe(200);
    }
    const denied = await req(started.base, '/auth/session', {
      method: 'POST',
      body: { google_access_token: GOOGLE_USER_C_TOKEN, machine_id: machine },
    });
    expect(denied.status).toBe(429);
    // The separate admin gateway is unaffected.
    const admin = await req(started.base, '/admin/login', {
      method: 'POST',
      body: { idToken: GOOGLE_ADMIN_TOKEN, provider: 'google' },
    });
    expect(admin.status).toBe(200);
  });

  it('admin sessions bypass the social daily quota', async () => {
    // Social-mode chat calls Google userinfo for each new social bearer token;
    // stub ONLY that URL and delegate everything else to the real fetch.
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return json({ sub: 'social-sub-1', email: 'social@example.com' });
      }
      return origFetch(input as string, init);
    }) as typeof fetch;
    try {
      started = await start(
        baseConfig({ socialAuth: true, dailyQuota: 1 }),
        mockRouter(),
      );
      const login = await req(started.base, '/admin/login', {
        method: 'POST',
        body: { idToken: GOOGLE_ADMIN_TOKEN, provider: 'google' },
      });
      expect(login.status).toBe(200);
      const adminToken = (login.json as { admin_token: string }).admin_token;
      const chat = (bearer: string) =>
        req(started!.base, '/v1/chat/completions', {
          method: 'POST',
          bearer,
          body: { model: 'mock:mock-model', messages: [{ role: 'user', content: 'hi' }] },
        });
      // Admin: 3 calls, no quota errors despite dailyQuota: 1.
      for (let i = 0; i < 3; i++) {
        const r = await chat(adminToken);
        expect(r.status).toBe(200);
      }
      // Social user: 1st OK, 2nd hits quota_exceeded.
      expect((await chat('social-token-1')).status).toBe(200);
      const limited = await chat('social-token-1');
      expect(limited.status).toBe(429);
      expect((limited.json as { error: { code: string } }).error.code).toBe('quota_exceeded');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
