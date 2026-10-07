import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ProviderRegistry,
  createDefaultRegistry,
  Router,
  parseModelRef,
  OpenRouterProvider,
  GroqProvider,
  SundayHostedProvider,
  SUNDAY_DEFAULT_API_URL,
  ProviderHttpError,
  parseSseStream,
  MockChatProvider,
  RateLimiter,
  getRetryAfterMs,
  type RouterPolicyConfig,
} from './index.js';

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l + '\n'));
      c.close();
    },
  });
}
const sse = (o: unknown) => `data: ${JSON.stringify(o)}`;

async function drain(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('parseModelRef', () => {
  it('splits provider:model refs', () => {
    expect(parseModelRef('openrouter:meta-llama/x', 'groq:y')).toEqual({
      providerId: 'openrouter',
      model: 'meta-llama/x',
    });
  });
  it('resolves bare ids against the default provider', () => {
    expect(parseModelRef('llama-3.3-70b-versatile', 'groq:other')).toEqual({
      providerId: 'groq',
      model: 'llama-3.3-70b-versatile',
    });
  });
});

describe('registry + router', () => {
  it('registers the four default providers and namespaces model ids', async () => {
    const r = createDefaultRegistry();
    // Local Model slice: ollama registers unconditionally; selection is
    // gated by sunday.localModel.enabled at the daemon layer.
    // Sunday hosted is first: zero-config for GitHub-signed-in users.
    expect(r.ids().sort()).toEqual(['groq', 'ollama', 'openrouter', 'sunday']);
    expect(r.ids()[0]).toBe('sunday'); // hosted default is registered first
    const models = await r.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.includes(':'))).toBe(true);
    expect(() => r.register(new GroqProvider())).toThrow(/already registered/);
    expect(() => r.get('nope')).toThrow(/unknown provider/);
  });

  it('routes explicit and default models', () => {
    const router = new Router(createDefaultRegistry());
    const a = router.route({ model: 'groq:llama-3.3-70b-versatile' });
    expect(a.provider.id).toBe('groq');
    expect(a.model).toBe('llama-3.3-70b-versatile');
    const b = router.route();
    expect(b.provider.id).toBe('sunday'); // zero-config hosted default
    expect(() => router.route({ model: 'nope:x' })).toThrow(/unknown provider/);
  });
});

describe('SSE parsing', () => {
  it('streams text deltas + usage and ends with done', async () => {
    const chunks = await drain(
      parseSseStream(
        sseStream([
          sse({ choices: [{ delta: { content: 'Hel' } }] }),
          sse({ choices: [{ delta: { content: 'lo' } }] }),
          sse({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          'data: [DONE]',
        ]),
      ),
    );
    const text = chunks
      .filter((c: any) => c.type === 'text-delta')
      .map((c: any) => c.delta)
      .join('');
    expect(text).toBe('Hello');
    expect((chunks.find((c: any) => c.type === 'usage') as any).usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'done', finishReason: 'stop' });
  });

  it('accumulates tool-call arguments split across chunks', async () => {
    const chunks = await drain(
      parseSseStream(
        sseStream([
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } },
                  ],
                },
              },
            ],
          }),
          sse({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/a.ts"}' } }] } }],
          }),
          sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]',
        ]),
      ),
    );
    const tc = chunks.find((c: any) => c.type === 'tool-call') as any;
    expect(tc.call).toMatchObject({
      id: 'call_1',
      name: 'read_file',
      arguments: { path: 'src/a.ts' },
    });
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'done', finishReason: 'tool_calls' });
  });

  it('flags unparseable tool arguments instead of silently dropping them', async () => {
    const chunks = await drain(
      parseSseStream(
        sseStream([
          sse({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'x', arguments: '{oops' } }] } },
            ],
          }),
          'data: [DONE]',
        ]),
      ),
    );
    const tc = chunks.find((c: any) => c.type === 'tool-call') as any;
    expect(tc.call.argumentsParseError).toContain('{oops');
  });
});

describe('Sunday hosted provider', () => {
  it('is unconfigured without a token', () => {
    delete process.env.SUNDAY_API_TOKEN;
    expect(new SundayHostedProvider().isConfigured()).toBe(false);
  });

  it('is configured with a token', () => {
    process.env.SUNDAY_API_TOKEN = 'gh-test-token';
    try {
      expect(new SundayHostedProvider().isConfigured()).toBe(true);
    } finally {
      delete process.env.SUNDAY_API_TOKEN;
    }
  });

  it('uses the default API URL unless overridden', () => {
    delete process.env.SUNDAY_API_URL;
    expect(new SundayHostedProvider().apiUrl()).toBe('https://sunday-ide.onrender.com');
    process.env.SUNDAY_API_URL = 'https://example.test/';
    try {
      expect(new SundayHostedProvider().apiUrl()).toBe('https://example.test');
    } finally {
      delete process.env.SUNDAY_API_URL;
    }
  });

  it('points at the production hosted gateway by default', () => {
    expect(SUNDAY_DEFAULT_API_URL).toBe('https://sunday-ide.onrender.com');
  });

  it('maps network failures to a friendly unreachable message', async () => {
    process.env.SUNDAY_API_TOKEN = 'gh-test-token';
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    try {
      const p = new SundayHostedProvider();
      await expect(
        drain(p.chat({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
      ).rejects.toThrow(
        /Sunday AI is unreachable\. Check your internet connection, or set SUNDAY_API_URL to a self-hosted gateway\./,
      );
    } finally {
      vi.unstubAllGlobals();
      delete process.env.SUNDAY_API_TOKEN;
    }
  });

  it('maps 401 to a friendly sign-in message with the original error as cause', async () => {
    process.env.SUNDAY_API_TOKEN = 'gh-test-token';
    vi.stubGlobal('fetch', async () => new Response('unauthorized', { status: 401 }));
    try {
      const p = new SundayHostedProvider();
      const err = await drain(
        p.chat({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/Sunday sign-in required: run the 'Sunday: Sign In' command/);
      expect(err.cause).toBeInstanceOf(ProviderHttpError);
      expect((err.cause as ProviderHttpError).status).toBe(401);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.SUNDAY_API_TOKEN;
    }
  });

  it('maps 429 to a friendly quota message', async () => {
    process.env.SUNDAY_API_TOKEN = 'gh-test-token';
    vi.stubGlobal('fetch', async () => new Response('quota exceeded', { status: 429 }));
    try {
      const p = new SundayHostedProvider();
      await expect(
        drain(p.chat({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
      ).rejects.toThrow(/Daily free AI quota exhausted \(200\/day\)/);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.SUNDAY_API_TOKEN;
    }
  });

  it('refuses to run without a token', async () => {
    delete process.env.SUNDAY_API_TOKEN;
    const p = new SundayHostedProvider();
    await expect(
      drain(p.chat({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
    ).rejects.toThrow(/SUNDAY_API_TOKEN/);
  });
});

describe('OpenRouter adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  it('sends an OpenAI-compatible request with provider headers', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      async (url: unknown, init: unknown) => {
        seen.push({ url: String(url), init: init as RequestInit });
        return new Response(sseStream(['data: [DONE]']), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    );
    await drain(
      new OpenRouterProvider().chat({
        model: 'openrouter:meta-llama/llama-3.3-70b-instruct',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
    expect(headers['HTTP-Referer']).toBeTruthy();
    const body = JSON.parse(seen[0].init.body as string);
    expect(body.model).toBe('meta-llama/llama-3.3-70b-instruct');
    expect(body.stream).toBe(true);
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'read_file' } });
    expect(body.messages[0]).toMatchObject({ role: 'user' });
  });

  it('throws a typed error on HTTP failures (e.g. 429)', async () => {
    process.env.GROQ_API_KEY = 'k';
    vi.stubGlobal('fetch', async () => new Response('rate limited', { status: 429 }));
    await expect(
      drain(new GroqProvider().chat({ model: 'groq:m', messages: [] })),
    ).rejects.toMatchObject({ name: 'ProviderHttpError', status: 429 });
  });

  it('serializes image parts as image_url content blocks', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      async (url: unknown, init: unknown) => {
        seen.push({ url: String(url), init: init as RequestInit });
        return new Response(sseStream(['data: [DONE]']), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    );
    await drain(
      new OpenRouterProvider().chat({
        model: 'openrouter:meta-llama/llama-3.3-70b-instruct',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' },
            ],
          },
        ],
      }),
    );
    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0].init.body as string);
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
      ],
    });
  });

  it('keeps all-text messages as a plain string (unchanged wire behavior)', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      async (url: unknown, init: unknown) => {
        seen.push({ url: String(url), init: init as RequestInit });
        return new Response(sseStream(['data: [DONE]']), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    );
    await drain(
      new OpenRouterProvider().chat({
        model: 'openrouter:meta-llama/llama-3.3-70b-instruct',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    );
    const body = JSON.parse(seen[0].init.body as string);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('refuses to run without an API key', async () => {
    await expect(
      drain(new GroqProvider().chat({ model: 'groq:m', messages: [] })),
    ).rejects.toThrow(/GROQ_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: router policies, rate-limit scheduler, visible Relay fallback
// ---------------------------------------------------------------------------

function relayPolicy(
  order: string[],
  on: Array<'rate-limit' | 'server-error'> = ['rate-limit'],
  enabled = true,
): RouterPolicyConfig {
  return { order, perProvider: {}, failover: { enabled, on } };
}

describe('rate-limit scheduler', () => {
  it('parks a provider+model in cooldown after a 429 until the clock passes', () => {
    const rl = new RateLimiter({ maxRequests: 100, windowMs: 1000 });
    const t0 = 1_000_000;
    expect(rl.acquire('p', 'm', t0)).toEqual({ ok: true });
    rl.noteRateLimited('p', 'm', 60_000, t0); // Retry-After: 60
    const during = rl.acquire('p', 'm', t0 + 59_999);
    expect(during.ok).toBe(false);
    if (!during.ok) expect(during.retryAfterMs).toBe(1);
    expect(rl.acquire('p', 'm', t0 + 60_000)).toEqual({ ok: true });
    // Other models on the same provider are unaffected.
    expect(rl.acquire('p', 'other', t0 + 1)).toEqual({ ok: true });
  });

  it('blocks the (N+1)th request inside the sliding window', () => {
    const rl = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
    const t0 = 5_000_000;
    expect(rl.acquire('p', 'm', t0).ok).toBe(true);
    expect(rl.acquire('p', 'm', t0 + 10).ok).toBe(true);
    const third = rl.acquire('p', 'm', t0 + 20);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.retryAfterMs).toBe(980);
    // The window slides: the first request expires 1000ms after t0.
    expect(rl.acquire('p', 'm', t0 + 1000).ok).toBe(true);
  });

  it('parses Retry-After seconds, HTTP dates, and ms header variants', () => {
    expect(getRetryAfterMs(new Headers({ 'retry-after': '60' }))).toBe(60_000);
    expect(getRetryAfterMs({ 'Retry-After': '2' })).toBe(2000);
    expect(getRetryAfterMs(new Headers({ 'retry-after-ms': '1500' }))).toBe(1500);
    expect(getRetryAfterMs(new Headers({ 'x-retry-after-ms': '250' }))).toBe(250);
    const future = new Date(Date.now() + 30_000).toUTCString();
    const parsed = getRetryAfterMs(new Headers({ 'retry-after': future }));
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(30_000);
    expect(getRetryAfterMs(new Headers())).toBeUndefined();
    expect(getRetryAfterMs(undefined)).toBeUndefined();
    expect(getRetryAfterMs(new Headers({ 'retry-after': 'not-a-value' }))).toBeUndefined();
  });
});

describe('router failover / visible relay', () => {
  function twoProviders() {
    const primary = new MockChatProvider({ id: 'primary', force429: true, retryAfterSec: 30 });
    const secondary = new MockChatProvider({
      id: 'secondary',
      scripts: [
        [
          { type: 'text-delta', delta: 'hello from secondary' },
          { type: 'done', finishReason: 'stop' } as const,
        ],
      ],
    });
    const registry = new ProviderRegistry();
    registry.register(primary);
    registry.register(secondary);
    return { registry };
  }

  it('relays to the next provider on forced 429 and returns from/to/reason', async () => {
    const { registry } = twoProviders();
    const router = new Router(
      registry,
      'primary:mock-model',
      relayPolicy(['primary', 'secondary']),
      new RateLimiter(),
    );
    const res = await router.chat({ model: 'primary:mock-model', messages: [] });
    expect(res.provider.id).toBe('secondary');
    expect(res.model).toBe('mock-model');
    expect(res.relay).toEqual({ from: 'primary', to: 'secondary', reason: 'rate-limit' });
    const text = (await drain(res.stream))
      .filter((c: any) => c.type === 'text-delta')
      .map((c: any) => c.delta)
      .join('');
    expect(text).toBe('hello from secondary');
    expect(res.attempts[0]).toMatchObject({ providerId: 'primary', ok: false });
    expect(res.attempts[res.attempts.length - 1]).toMatchObject({
      providerId: 'secondary',
      ok: true,
    });
  });

  it('respects policy order: first usable provider wins, no relay', async () => {
    const { registry } = twoProviders();
    const router = new Router(
      registry,
      'secondary:mock-model',
      relayPolicy(['secondary', 'primary']),
      new RateLimiter(),
    );
    const res = await router.chat({ model: 'secondary:mock-model', messages: [] });
    expect(res.provider.id).toBe('secondary');
    expect(res.relay).toBeUndefined();
  });

  it('with failover disabled, the 429 surfaces as an error (no silent relay)', async () => {
    const { registry } = twoProviders();
    const router = new Router(
      registry,
      'primary:mock-model',
      relayPolicy(['primary', 'secondary'], ['rate-limit'], false),
      new RateLimiter(),
    );
    await expect(router.chat({ model: 'primary:mock-model', messages: [] })).rejects.toMatchObject(
      { name: 'ProviderHttpError', status: 429 },
    );
  });

  it('relays on 5xx only when failover.on includes server-error', async () => {
    const bad = new MockChatProvider({ id: 'bad', forceStatus: 503 });
    const good = new MockChatProvider({
      id: 'good',
      scripts: [[{ type: 'done', finishReason: 'stop' } as const]],
    });
    const registry = new ProviderRegistry();
    registry.register(bad);
    registry.register(good);

    const withServerError = new Router(
      registry,
      'bad:mock-model',
      relayPolicy(['bad', 'good'], ['rate-limit', 'server-error']),
      new RateLimiter(),
    );
    const res = await withServerError.chat({ model: 'bad:mock-model', messages: [] });
    expect(res.provider.id).toBe('good');
    expect(res.relay).toEqual({ from: 'bad', to: 'good', reason: 'server-error' });

    const without = new Router(
      registry,
      'bad:mock-model',
      relayPolicy(['bad', 'good'], ['rate-limit']),
      new RateLimiter(),
    );
    await expect(without.chat({ model: 'bad:mock-model', messages: [] })).rejects.toMatchObject({
      status: 503,
    });
  });

  it('skips a cooled-down provider and reports the relay visibly', async () => {
    const { registry } = twoProviders();
    const limiter = new RateLimiter();
    limiter.noteRateLimited('primary', 'mock-model', 60_000); // parked by an earlier 429
    const router = new Router(
      registry,
      'primary:mock-model',
      relayPolicy(['primary', 'secondary']),
      limiter,
    );
    const res = await router.chat({ model: 'primary:mock-model', messages: [] });
    expect(res.provider.id).toBe('secondary');
    expect(res.relay).toEqual({ from: 'primary', to: 'secondary', reason: 'rate-limit' });
    expect(res.attempts[0]).toMatchObject({ providerId: 'primary', skipped: 'cooldown' });
  });

  it('honours per-provider model allowlists when resolving by bare model id', async () => {
    const { registry } = twoProviders();
    const policy: RouterPolicyConfig = {
      order: ['primary', 'secondary'],
      perProvider: { primary: { models: ['other-model'] } },
      failover: { enabled: true, on: ['rate-limit'] },
    };
    const router = new Router(registry, 'primary:mock-model', policy, new RateLimiter());
    // Bare ref: primary cannot serve 'mock-model', so secondary is preferred — no relay.
    const res = await router.chat({ model: 'mock-model', messages: [] });
    expect(res.provider.id).toBe('secondary');
    expect(res.relay).toBeUndefined();
  });

  it('legacy path without a policy still routes a single provider', async () => {
    const secondary = new MockChatProvider({
      id: 'secondary',
      scripts: [[{ type: 'done', finishReason: 'stop' } as const]],
    });
    const registry = new ProviderRegistry();
    registry.register(secondary);
    const router = new Router(registry, 'secondary:mock-model');
    const res = await router.chat({ model: 'secondary:mock-model', messages: [] });
    expect(res.provider.id).toBe('secondary');
    expect(res.relay).toBeUndefined();
    const chunks = await drain(res.stream);
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'done' });
  });
});
