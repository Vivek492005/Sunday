import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProviderRegistry,
  Router,
  MockChatProvider,
  type ChatChunk,
} from '@sunday/gateway';
import type { HostedGatewayConfig } from './config.js';
import { HostedGatewayServer } from './server.js';

const KEY = 'test-secret-1';

function baseConfig(overrides: Partial<HostedGatewayConfig> = {}): HostedGatewayConfig {
  return {
    port: 0, // ephemeral
    host: '127.0.0.1',
    keys: [{ id: 'tester', secret: KEY }],
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
    sessionSecret: 'test-session-secret-not-for-production',
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
  dataDir?: string,
): Promise<Started> {
  const server = new HostedGatewayServer(config, {
    ...(mocked ?? {}),
    ...(dataDir ? { dataDir } : {}),
  });
  await server.listen();
  const a = server.address();
  return { server, base: `http://${a.host}:${a.port}` };
}

async function req(
  base: string,
  path: string,
  opts: { method?: string; key?: string; body?: unknown; rawBody?: string } = {},
): Promise<{ status: number; headers: Headers; json: unknown; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.key !== undefined) headers['authorization'] = `Bearer ${opts.key}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers, body });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave as null
  }
  return { status: res.status, headers: res.headers, json, text };
}

describe('HostedGatewayServer', () => {
  let started: Started | undefined;
  // A1: isolated task-store dirs (the default data dir is shared otherwise).
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await started?.server.close();
    started = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Start a server whose agent-task store lives in a fresh tmp dir. */
  async function startIsolated(
    config: HostedGatewayConfig,
    mocked?: { router: Router; registry: ProviderRegistry },
  ): Promise<Started> {
    const dataDir = mkdtempSync(join(tmpdir(), 'sunday-gw-agent-tasks-'));
    tmpDirs.push(dataDir);
    // The gateway requires data/plans.json (entitlements); seed it from
    // the repo's real plans file.
    const here = dirname(fileURLToPath(import.meta.url));
    copyFileSync(join(here, '..', 'data', 'plans.json'), join(dataDir, 'plans.json'));
    return start(config, mocked, dataDir);
  }

  it('serves /health without auth', async () => {
    started = await start(baseConfig());
    const r = await req(started.base, '/health');
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
  });

  it('returns 401 without a key and 401 with a wrong key', async () => {
    started = await start(baseConfig());
    expect((await req(started.base, '/v1/models')).status).toBe(401);
    expect((await req(started.base, '/v1/models', { key: 'wrong' })).status).toBe(401);
  });

  it('serves /v1/models with a valid key', async () => {
    started = await start(baseConfig(), mockRouter());
    const r = await req(started.base, '/v1/models', { key: KEY });
    expect(r.status).toBe(200);
    const data = (r.json as { data: Array<{ id: string }> }).data;
    expect(data.some((m) => m.id === 'mock:mock-model')).toBe(true);
  });

  it('completes a chat request (non-streaming)', async () => {
    started = await start(baseConfig(), mockRouter());
    const r = await req(started.base, '/v1/chat/completions', {
      method: 'POST',
      key: KEY,
      body: { model: 'mock:mock-model', messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(r.status).toBe(200);
    const j = r.json as { choices: Array<{ message: { content: string } }>; usage: object };
    expect(j.choices[0]!.message.content).toBe('hi');
    expect(j.usage).toBeDefined();
  });

  it('streams SSE when stream:true', async () => {
    started = await start(baseConfig(), mockRouter());
    const r = await req(started.base, '/v1/chat/completions', {
      method: 'POST',
      key: KEY,
      body: { model: 'mock:mock-model', messages: [{ role: 'user', content: 'hello' }], stream: true },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(r.text).toContain('data: [DONE]');
    expect(r.text).toContain('"content":"hi"');
  });

  it('rejects tools with 400', async () => {
    started = await start(baseConfig(), mockRouter());
    const r = await req(started.base, '/v1/chat/completions', {
      method: 'POST',
      key: KEY,
      body: {
        model: 'mock:mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'x' } }],
      },
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe('tools_not_supported');
  });

  it('rejects a disallowed model with 403', async () => {
    started = await start(baseConfig({ allowedModels: ['mock:other'] }), mockRouter());
    const r = await req(started.base, '/v1/chat/completions', {
      method: 'POST',
      key: KEY,
      body: { model: 'mock:mock-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.status).toBe(403);
  });

  it('rate-limits with 429 and Retry-After', async () => {
    started = await start(baseConfig({ requestsPerMinute: 1 }), mockRouter([
      [{ type: 'text-delta', delta: 'a' }, { type: 'done', finishReason: 'stop' }],
      [{ type: 'text-delta', delta: 'b' }, { type: 'done', finishReason: 'stop' }],
    ]));
    const body = { model: 'mock:mock-model', messages: [{ role: 'user', content: 'hi' }] };
    expect((await req(started.base, '/v1/chat/completions', { method: 'POST', key: KEY, body })).status).toBe(200);
    const r2 = await req(started.base, '/v1/chat/completions', { method: 'POST', key: KEY, body });
    expect(r2.status).toBe(429);
    expect(r2.headers.get('retry-after')).toBeTruthy();
  });

  it('rejects oversized bodies with 413', async () => {
    started = await start(baseConfig({ maxBodyBytes: 16 }), mockRouter());
    const r = await req(started.base, '/v1/chat/completions', {
      method: 'POST',
      key: KEY,
      rawBody: '{"model":"x","messages":[]}',
    });
    expect(r.status).toBe(413);
  });

  it('rejects invalid JSON with 400', async () => {
    started = await start(baseConfig(), mockRouter());
    const r = await req(started.base, '/v1/chat/completions', {
      method: 'POST',
      key: KEY,
      rawBody: '{not json',
    });
    expect(r.status).toBe(400);
  });

  it('returns 404 for unknown routes', async () => {
    started = await start(baseConfig());
    expect((await req(started.base, '/nope', { key: KEY })).status).toBe(404);
  });

  it('drops tool-call chunks instead of executing them', async () => {
    started = await start(
      baseConfig(),
      mockRouter([[
        { type: 'tool-call', call: { id: 'c1', name: 'run_shell', arguments: { cmd: 'rm -rf /' } } },
        { type: 'text-delta', delta: 'done' },
        { type: 'done', finishReason: 'tool_calls' },
      ]]),
    );
    const r = await req(started.base, '/v1/chat/completions', {
      method: 'POST',
      key: KEY,
      body: { model: 'mock:mock-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.status).toBe(200);
    const j = r.json as { choices: Array<{ message: { content: string }; finish_reason: string }> };
    expect(j.choices[0]!.message.content).toBe('done');
    expect(j.choices[0]!.finish_reason).toBe('stop');
  });

  it('enforces the IP allowlist', async () => {
    // 127.0.0.1 is the client IP in these tests; allowlist something else.
    started = await start(baseConfig({ ipAllowlist: ['10.99.99.99'] }));
    const r = await req(started.base, '/health');
    expect(r.status).toBe(403);
  });

  // A1: async agent tasks -------------------------------------------------------
  it('requires auth for /agent/tasks', async () => {
    started = await startIsolated(baseConfig());
    expect((await req(started.base, '/agent/tasks')).status).toBe(401);
    expect((await req(started.base, '/agent/tasks', { key: 'wrong' })).status).toBe(401);
    const r = await req(started.base, '/agent/tasks', { key: KEY });
    expect(r.status).toBe(200);
    expect((r.json as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it('runs the task lifecycle create \u2192 claim \u2192 complete over HTTP', async () => {
    started = await startIsolated(baseConfig(), mockRouter());
    const base = started.base;

    const created = await req(base, '/agent/tasks', {
      method: 'POST',
      key: KEY,
      body: { prompt: 'summarize the repo', repo_context: 'sunday' },
    });
    expect(created.status).toBe(201);
    const task = (created.json as { task: { id: string; status: string } }).task;
    expect(task.status).toBe('queued');
    expect(created.json).not.toHaveProperty('userId');

    const listed = await req(base, '/agent/tasks', { key: KEY });
    expect((listed.json as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id)).toEqual([task.id]);

    const fetched = await req(base, `/agent/tasks/${task.id}`, { key: KEY });
    expect(fetched.status).toBe(200);
    expect((fetched.json as { task: { status: string } }).task.status).toBe('queued');

    const claimed = await req(base, `/agent/tasks/${task.id}/claim`, { method: 'POST', key: KEY });
    expect(claimed.status).toBe(200);
    expect((claimed.json as { task: { status: string } }).task.status).toBe('claimed');

    // Double-claim is a conflict, not a silent re-claim.
    const claimed2 = await req(base, `/agent/tasks/${task.id}/claim`, { method: 'POST', key: KEY });
    expect(claimed2.status).toBe(409);

    const done = await req(base, `/agent/tasks/${task.id}/result`, {
      method: 'POST',
      key: KEY,
      body: { result: 'done: 12 files summarized' },
    });
    expect(done.status).toBe(200);
    const final = (done.json as { task: { status: string; result: string } }).task;
    expect(final.status).toBe('completed');
    expect(final.result).toBe('done: 12 files summarized');
  });

  it('rejects invalid task payloads with 400', async () => {
    started = await startIsolated(baseConfig(), mockRouter());
    const base = started.base;
    expect(
      (await req(base, '/agent/tasks', { method: 'POST', key: KEY, body: {} })).status,
    ).toBe(400);
    expect(
      (await req(base, '/agent/tasks', { method: 'POST', key: KEY, body: { prompt: '  ' } })).status,
    ).toBe(400);
    expect(
      (
        await req(base, '/agent/tasks/task_x/result', {
          method: 'POST',
          key: KEY,
          body: { nope: 1 },
        })
      ).status,
    ).toBe(400);
  });

  it('returns 404 for unknown task ids and isolates tasks per key', async () => {
    started = await startIsolated(baseConfig({ keys: [{ id: 'a', secret: 'key-a' }, { id: 'b', secret: 'key-b' }] }), mockRouter());
    const base = started.base;
    const created = await req(base, '/agent/tasks', {
      method: 'POST',
      key: 'key-a',
      body: { prompt: 'private' },
    });
    const id = (created.json as { task: { id: string } }).task.id;
    // Other identity sees nothing.
    expect((await req(base, `/agent/tasks/${id}`, { key: 'key-b' })).status).toBe(404);
    expect(
      (await req(base, `/agent/tasks/${id}/claim`, { method: 'POST', key: 'key-b' })).status,
    ).toBe(409);
    expect(((await req(base, '/agent/tasks', { key: 'key-b' })).json as { tasks: unknown[] }).tasks).toEqual([]);
    expect((await req(base, '/agent/tasks/task_missing', { key: 'key-a' })).status).toBe(404);
  });
});

describe('config loading', () => {
  beforeEach(() => {
    // nothing
  });

  it('throws when no keys are configured', async () => {
    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig({ ...process.env, SUNDAY_HOSTED_KEYS: '', SUNDAY_HOSTED_CONFIG: '' })).toThrow(
      /no API keys/,
    );
  });

  it('parses id:secret pairs and bare secrets', async () => {
    const { loadConfig } = await import('./config.js');
    const c = loadConfig({
      ...process.env,
      SUNDAY_HOSTED_KEYS: 'alice:s1,bare2',
      SUNDAY_SESSION_SECRET: 's3cret-for-tests',
    });
    expect(c.keys).toEqual([
      { id: 'alice', secret: 's1' },
      { id: 'key-2', secret: 'bare2' },
    ]);
    expect(c.port).toBe(8080);
    expect(c.host).toBe('127.0.0.1');
  });
});
