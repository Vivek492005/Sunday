// Gateway FIM tests: native /completions path, prefix-only chat fallback,
// and abort propagation. `fetch` is mocked; no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroqProvider, OpenRouterProvider } from './providers.js';

interface Seen {
  url: string;
  init: RequestInit;
}

function mockFetch(handler: (seen: Seen[], url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init: unknown) => {
    const s = { url: String(url), init: init as RequestInit };
    seen.push(s);
    return handler(seen, s.url, s.init);
  });
  return seen;
}

const jsonOk = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const bodyOf = (s: Seen) => JSON.parse(s.init.body as string) as Record<string, any>;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GROQ_API_KEY;
});

describe('FIM: native path (OpenRouter model advertising supportsFim)', () => {
  it('POSTs /completions with prompt + suffix and returns the infill text', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const seen = mockFetch((_s, url) => {
      expect(url).toBe('https://openrouter.ai/api/v1/completions');
      return jsonOk({ choices: [{ text: ' + 1;' }] });
    });
    const res = await new OpenRouterProvider().complete({
      model: 'openrouter:qwen/qwen-2.5-coder-32b-instruct',
      prefix: 'const x = 1',
      suffix: '\nconsole.log(x);',
      maxTokens: 32,
    });
    expect(res).toEqual({ completion: ' + 1;', nativeFim: true });
    expect(seen).toHaveLength(1);
    const body = bodyOf(seen[0]);
    expect(body).toMatchObject({
      model: 'qwen/qwen-2.5-coder-32b-instruct',
      prompt: 'const x = 1',
      suffix: '\nconsole.log(x);',
      max_tokens: 32,
      temperature: 0,
    });
  });

  it('advertises supportsFim on the coder model entry', async () => {
    const models = await new OpenRouterProvider().listModels();
    const coder = models.find((m) => m.id === 'qwen/qwen-2.5-coder-32b-instruct');
    expect(coder?.supportsFim).toBe(true);
    for (const m of models) expect(typeof m.supportsFim).toBe('boolean');
  });
});

describe('FIM: graceful fallback (no native endpoint)', () => {
  it('Groq (no FIM endpoint) uses prefix-only chat/completions, suffix dropped', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const seen = mockFetch((_s, url) => {
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
      return jsonOk({ choices: [{ message: { content: ' + 1;' } }] });
    });
    const res = await new GroqProvider().complete({
      model: 'groq:llama-3.1-8b-instant',
      prefix: 'const x = 1',
      suffix: '\nconsole.log(x);',
    });
    expect(res).toEqual({ completion: ' + 1;', nativeFim: false });
    expect(seen).toHaveLength(1);
    const body = bodyOf(seen[0]);
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([{ role: 'user', content: 'const x = 1' }]);
    expect('suffix' in body).toBe(false);
  });

  it('OpenRouter non-FIM model falls back to chat/completions', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const seen = mockFetch((_s, url) => {
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      return jsonOk({ choices: [{ message: { content: 'done' } }] });
    });
    const res = await new OpenRouterProvider().complete({
      model: 'openrouter:meta-llama/llama-3.3-70b-instruct',
      prefix: 'hello',
    });
    expect(res.nativeFim).toBe(false);
    expect(res.completion).toBe('done');
    expect(seen).toHaveLength(1);
  });

  it('native endpoint failure falls back to chat instead of throwing', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const seen = mockFetch((_s, url) => {
      // NB: '/chat/completions' also ends with '/completions' — check the
      // more specific path first so the chat fallback gets its 200.
      if (url.endsWith('/chat/completions')) {
        return jsonOk({ choices: [{ message: { content: 'fallback-text' } }] });
      }
      if (url.endsWith('/completions')) {
        return new Response('nope', { status: 404 });
      }
      return jsonOk({ choices: [{ message: { content: 'fallback-text' } }] });
    });
    const res = await new OpenRouterProvider().complete({
      model: 'openrouter:qwen/qwen-2.5-coder-32b-instruct',
      prefix: 'const x = 1',
      suffix: 'tail',
    });
    expect(res).toEqual({ completion: 'fallback-text', nativeFim: false });
    expect(seen).toHaveLength(2);
  });
});

describe('FIM: abort handling', () => {
  it('propagates AbortError on the fallback path (never swallows)', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    mockFetch(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const controller = new AbortController();
    await expect(
      new GroqProvider().complete({
        model: 'groq:llama-3.1-8b-instant',
        prefix: 'x',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('propagates AbortError on the native path without attempting fallback', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const seen = mockFetch(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      new OpenRouterProvider().complete({
        model: 'openrouter:qwen/qwen-2.5-coder-32b-instruct',
        prefix: 'x',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // Native attempt only — no fallback retry after an abort.
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://openrouter.ai/api/v1/completions');
  });
});
