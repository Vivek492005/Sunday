import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ProviderRegistry,
  createDefaultRegistry,
  Router,
  parseModelRef,
  OpenRouterProvider,
  GroqProvider,
  ProviderHttpError,
  parseSseStream,
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
  it('registers the two default providers and namespaces model ids', async () => {
    const r = createDefaultRegistry();
    expect(r.ids().sort()).toEqual(['groq', 'openrouter']);
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
    expect(b.provider.id).toBe('openrouter');
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

  it('refuses to run without an API key', async () => {
    await expect(
      drain(new GroqProvider().chat({ model: 'groq:m', messages: [] })),
    ).rejects.toThrow(/GROQ_API_KEY/);
  });
});
