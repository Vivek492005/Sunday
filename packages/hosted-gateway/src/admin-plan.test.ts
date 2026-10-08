// Tests for Task 8 (Phase 9.b): plans.json wired in at startup, upgraded
// GET /me/entitlements, and POST /admin/users/:id/plan.
//
// Covers: plans.json loads at startup / invalid file -> boot error, admin
// auth (missing env -> 403, wrong key -> 403, wrong-length key -> 403),
// unknown user -> 404, invalid plan -> 400, happy path + persistence,
// /me/entitlements reflecting the new plan, user-record migration
// (no plan -> basic), and the backward-compat top-level plan+entitlements.
import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedGatewayServer } from './server.js';
import type { HostedGatewayConfig } from './config.js';
import { SUNDAY_GOOGLE_CLIENT_ID } from './accounts.js';

// Test-only fixtures (never production secrets).
const SESSION_SECRET = 'task8-test-session-secret-not-for-production';
const ADMIN_KEY = 'task8-test-admin-key-not-for-production';
const GOOGLE_TOKEN = 'task8-test-google-token';

const PLANS_FIXTURE = new URL('../data/plans.json', import.meta.url);

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
        sub: 'google-sub-task8',
        expires_in: '3599',
        aud: SUNDAY_GOOGLE_CLIENT_ID,
        email: 'admin-test@example.com',
      });
    }
    return json({ error: 'invalid_token' }, 400);
  }
  if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
    const auth = new Headers(init?.headers).get('authorization');
    if (auth === `Bearer ${GOOGLE_TOKEN}`) {
      return json({
        sub: 'google-sub-task8',
        email: 'admin-test@example.com',
        name: 'Admin Test',
        picture: 'https://example.com/pic.png',
      });
    }
    return json({ error: 'invalid_token' }, 401);
  }
  return json({ error: 'unexpected url' }, 500);
}

/** Mint a Sunday session JWT exactly the way AccountsService does. */
function sessionToken(userId: string): string {
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64(JSON.stringify({ sub: userId, iat: now, exp: now + 3600 }));
  const sig = createHmac('sha256', SESSION_SECRET).update(`${h}.${p}`, 'utf8').digest('base64url');
  return `${h}.${p}.${sig}`;
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

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'sunday-admin-plan-test-'));
}

/** Seed the committed plans.json templates into a tmp data dir. */
function seedPlans(dataDir: string): void {
  copyFileSync(PLANS_FIXTURE, join(dataDir, 'plans.json'));
}

interface Started {
  server: HostedGatewayServer;
  base: string;
  dataDir: string;
}

async function start(config: HostedGatewayConfig, dataDir?: string): Promise<Started> {
  const dir = dataDir ?? freshDataDir();
  const server = new HostedGatewayServer(config, {
    dataDir: dir,
    accountsFetch: mockGoogleFetch as typeof fetch,
  });
  await server.listen();
  const a = server.address();
  return { server, base: `http://${a.host}:${a.port}`, dataDir: dir };
}

async function req(
  base: string,
  path: string,
  opts: { method?: string; bearer?: string; adminKey?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.adminKey !== undefined) headers['x-admin-key'] = opts.adminKey;
  let body: string | undefined;
  if (opts.body !== undefined) {
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
  return { status: res.status, json: parsed, text };
}

async function signIn(base: string): Promise<{ session: string; userId: string }> {
  const r = await req(base, '/auth/session', {
    method: 'POST',
    body: { google_access_token: GOOGLE_TOKEN },
  });
  expect(r.status).toBe(200);
  const j = r.json as { session_token: string; user: { id: string } };
  return { session: j.session_token, userId: j.user.id };
}

function errCode(json: unknown): string | undefined {
  const e = (json as { error?: { code?: string } } | null)?.error;
  return e?.code;
}

describe('plans.json at startup', () => {
  it('invalid plans.json -> clear boot error (constructor throws)', () => {
    const dir = freshDataDir();
    writeFileSync(join(dir, 'plans.json'), '{not valid json', 'utf8');
    expect(() => new HostedGatewayServer(baseConfig({ adminKey: ADMIN_KEY }), { dataDir: dir })).toThrow(
      /plans\.json/,
    );
  });

  it('missing plans.json -> clear boot error (fail closed)', () => {
    const dir = freshDataDir();
    expect(() => new HostedGatewayServer(baseConfig({ adminKey: ADMIN_KEY }), { dataDir: dir })).toThrow(
      /plans\.json not found/,
    );
  });

  it('schema-violating plans.json -> boot error (no basic plan)', () => {
    const dir = freshDataDir();
    writeFileSync(
      join(dir, 'plans.json'),
      JSON.stringify({ version: 1, plans: [] }),
      'utf8',
    );
    expect(() => new HostedGatewayServer(baseConfig({ adminKey: ADMIN_KEY }), { dataDir: dir })).toThrow(
      /plans\.json/,
    );
  });
});

describe('POST /admin/users/:id/plan', () => {
  let started: Started | undefined;
  afterEach(async () => {
    await started?.server.close();
    started = undefined;
  });

  it('admin without key (missing env) -> 403, even with a Bearer credential', async () => {
    const dir = freshDataDir();
    seedPlans(dir);
    started = await start(baseConfig(), dir); // no adminKey configured
    const { userId } = await signIn(started.base);
    const r = await req(started.base, `/admin/users/${userId}/plan`, {
      method: 'POST',
      bearer: 'test-secret-1',
      adminKey: 'whatever',
      body: { plan: 'pro' },
    });
    expect(r.status).toBe(403);
    expect(errCode(r.json)).toBe('admin_not_configured');
  });

  it('wrong admin key -> 403 (incl. wrong-length key: no throw, fail closed)', async () => {
    const dir = freshDataDir();
    seedPlans(dir);
    started = await start(baseConfig({ adminKey: ADMIN_KEY }), dir);
    const { userId } = await signIn(started.base);
    for (const bad of ['wrong-key', 'short', `${ADMIN_KEY}-with-extra-suffix-making-it-longer`]) {
      const r = await req(started.base, `/admin/users/${userId}/plan`, {
        method: 'POST',
        adminKey: bad,
        body: { plan: 'pro' },
      });
      expect(r.status).toBe(403);
      expect(errCode(r.json)).toBe('admin_forbidden');
    }
  });

  it('unknown user -> 404', async () => {
    const dir = freshDataDir();
    seedPlans(dir);
    started = await start(baseConfig({ adminKey: ADMIN_KEY }), dir);
    const r = await req(started.base, '/admin/users/u_doesnotexist/plan', {
      method: 'POST',
      adminKey: ADMIN_KEY,
      body: { plan: 'pro' },
    });
    expect(r.status).toBe(404);
    expect(errCode(r.json)).toBe('unknown_user');
  });

  it('invalid plan -> 400 (bad id, missing, wrong type)', async () => {
    const dir = freshDataDir();
    seedPlans(dir);
    started = await start(baseConfig({ adminKey: ADMIN_KEY }), dir);
    const { userId } = await signIn(started.base);
    for (const body of [{ plan: 'ultra' }, {}, { plan: 42 }, { plan: 'PRO' }]) {
      const r = await req(started.base, `/admin/users/${userId}/plan`, {
        method: 'POST',
        adminKey: ADMIN_KEY,
        body,
      });
      expect(r.status).toBe(400);
      expect(errCode(r.json)).toBe('invalid_plan');
    }
  });

  it('happy path: sets plan, persists the record, returns the full view', async () => {
    const dir = freshDataDir();
    seedPlans(dir);
    started = await start(baseConfig({ adminKey: ADMIN_KEY }), dir);
    const { session, userId } = await signIn(started.base);

    const r = await req(started.base, `/admin/users/${userId}/plan`, {
      method: 'POST',
      adminKey: ADMIN_KEY,
      body: { plan: 'pro' },
    });
    expect(r.status).toBe(200);
    const view = r.json as Record<string, unknown>;
    expect(view.user_id).toBe(userId);
    expect(view.plan).toBe('pro');
    expect(view.status).toBe('active');
    const ent = view.entitlements as Record<string, unknown>;
    expect(ent['managed_models.daily_requests']).toBe(1500);
    expect(ent['orchestration.parallel']).toBe(true);
    expect(ent['browser_agent.daily_sessions']).toBe(50);

    // Persisted: users.json carries the new plan.
    const stored = JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8')) as Array<{
      id: string;
      plan: string;
    }>;
    expect(stored.find((u) => u.id === userId)?.plan).toBe('pro');

    // /me/entitlements now serves the pro view (backward-compat keys kept).
    const me = await req(started.base, '/me/entitlements', { bearer: session });
    expect(me.status).toBe(200);
    const mev = me.json as Record<string, unknown>;
    expect(mev.user_id).toBe(userId);
    expect(mev.plan).toBe('pro');
    expect((mev.entitlements as Record<string, unknown>)['managed_models.daily_requests']).toBe(1500);

    // And toggling back to smart works the same way.
    const r2 = await req(started.base, `/admin/users/${userId}/plan`, {
      method: 'POST',
      adminKey: ADMIN_KEY,
      body: { plan: 'smart' },
    });
    expect(r2.status).toBe(200);
    const me2 = await req(started.base, '/me/entitlements', { bearer: session });
    const mev2 = me2.json as Record<string, unknown>;
    expect(mev2.plan).toBe('smart');
    expect((mev2.entitlements as Record<string, unknown>)['managed_models.daily_requests']).toBe(300);
    expect((mev2.entitlements as Record<string, unknown>)['browser_agent.enabled']).toBe(true);
  });

  it('migrates old user records without a plan -> basic', async () => {
    const dir = freshDataDir();
    seedPlans(dir);
    const legacy = [
      {
        id: 'u_legacy01',
        google_sub: 'google-sub-legacy',
        email: 'legacy@example.com',
        display_name: 'Legacy',
        avatar_url: '',
        created_at: '2026-09-01T00:00:00.000Z',
      },
    ];
    writeFileSync(join(dir, 'users.json'), JSON.stringify(legacy), 'utf8');
    started = await start(baseConfig(), dir);

    const r = await req(started.base, '/me/entitlements', { bearer: sessionToken('u_legacy01') });
    expect(r.status).toBe(200);
    const view = r.json as Record<string, unknown>;
    expect(view.plan).toBe('basic');
    expect((view.entitlements as Record<string, unknown>)['managed_models.daily_requests']).toBe(200);

    // The migration was persisted back to users.json.
    const stored = JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8')) as Array<{
      id: string;
      plan?: string;
    }>;
    expect(stored.find((u) => u.id === 'u_legacy01')?.plan).toBe('basic');
  });

  it('unknown session user -> 404 on /me/entitlements', async () => {
    const dir = freshDataDir();
    seedPlans(dir);
    started = await start(baseConfig(), dir);
    const r = await req(started.base, '/me/entitlements', { bearer: sessionToken('u_ghost') });
    expect(r.status).toBe(404);
    expect(errCode(r.json)).toBe('unknown_user');
  });
});
