// Route tests for GET /me/usage (D2).
//
// - session auth is required (401 without a token, 401 with a plain gateway
//   API key, 401 with a wrong-secret token)
// - the response shape matches the dashboard contract
// - a completed chat completion feeds the meter (today + by_model + history)
import { createHmac } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import {
  ProviderRegistry,
  Router,
  MockChatProvider,
} from '@sunday/gateway';
import type { HostedGatewayConfig } from './config.js';
import { HostedGatewayServer } from './server.js';

const SESSION_SECRET = 'test-session-secret-not-for-production';

function baseConfig(): HostedGatewayConfig {
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
    oauthProviders: ['github'],
    dailyQuota: 200,
    sessionSecret: SESSION_SECRET,
  };
}

/** Mint a Sunday session JWT exactly the way AccountsService does. */
function sessionToken(userId: string, secret: string = SESSION_SECRET): string {
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64(JSON.stringify({ sub: userId, iat: now, exp: now + 3600 }));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`, 'utf8').digest('base64url');
  return `${h}.${p}.${sig}`;
}

const servers: HostedGatewayServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function startServer(): Promise<string> {
  const registry = new ProviderRegistry();
  registry.register(
    new MockChatProvider({
      id: 'mock',
      scripts: [[{ type: 'text-delta', delta: 'hello world' }, { type: 'done', finishReason: 'stop' }]],
    }),
  );
  const server = new HostedGatewayServer(baseConfig(), {
    registry,
    router: new Router(registry, 'mock:mock-model'),
  });
  await server.listen();
  servers.push(server);
  const a = server.address();
  return `http://${a.host}:${a.port}`;
}

async function req(
  base: string,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json };
}

describe('GET /me/usage', () => {
  it('requires a valid Sunday session token', async () => {
    const base = await startServer();
    expect((await req(base, '/me/usage')).status).toBe(401);
    // Plain gateway API key is not enough (per-user metering, not shared creds).
    expect((await req(base, '/me/usage', { token: 'test-secret-1' })).status).toBe(401);
    // Wrong signing secret.
    expect((await req(base, '/me/usage', { token: sessionToken('u1', 'wrong') })).status).toBe(401);
    expect((await req(base, '/me/usage', { token: 'garbage' })).status).toBe(401);
  });

  it('returns the dashboard shape for a fresh user (empty data)', async () => {
    const base = await startServer();
    const r = await req(base, '/me/usage', { token: sessionToken('user-1') });
    expect(r.status).toBe(200);
    expect(r.json.today).toEqual({ requests: 0, tokens_in: 0, tokens_out: 0 });
    expect(r.json.by_model).toEqual([]);
    expect(r.json.history_7d).toHaveLength(7);
  });

  it('reflects a completed chat completion (non-stream)', async () => {
    const base = await startServer();
    const token = sessionToken('user-2');
    const chat = await req(base, '/v1/chat/completions', {
      method: 'POST',
      token,
      body: {
        model: 'mock:mock-model',
        messages: [{ role: 'user', content: 'hi there' }],
      },
    });
    expect(chat.status).toBe(200);
    const r = await req(base, '/me/usage', { token });
    expect(r.status).toBe(200);
    expect(r.json.today.requests).toBe(1);
    expect(r.json.today.tokens_in).toBeGreaterThan(0);
    expect(r.json.today.tokens_out).toBeGreaterThan(0);
    expect(r.json.by_model).toHaveLength(1);
    expect(r.json.by_model[0].model).toBe('mock:mock-model');
    expect(r.json.history_7d[6].requests).toBe(1);
  });

  it('isolates usage between users', async () => {
    const base = await startServer();
    const t1 = sessionToken('alice');
    await req(base, '/v1/chat/completions', {
      method: 'POST',
      token: t1,
      body: { model: 'mock:mock-model', messages: [{ role: 'user', content: 'x' }] },
    });
    const r = await req(base, '/me/usage', { token: sessionToken('bob') });
    expect(r.json.today.requests).toBe(0);
  });
});
