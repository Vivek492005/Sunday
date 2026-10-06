// Gateway Ollama provider tests (Local Model slice). `fetch` is mocked;
// no network, no real Ollama required.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OLLAMA_DEFAULT_MODEL,
  OllamaProvider,
  createDefaultRegistry,
} from './index.js';

interface Seen {
  url: string;
  init: RequestInit;
}

function mockFetch(
  handler: (seen: Seen[], url: string, init: RequestInit) => Response | Promise<Response>,
) {
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

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GROQ_API_KEY;
});

describe('OllamaProvider identity + registration', () => {
  it('registers under id "ollama" in the default registry', () => {
    const r = createDefaultRegistry();
    expect(r.ids()).toContain('ollama');
    expect(r.get('ollama')).toBeInstanceOf(OllamaProvider);
  });

  it('exposes the default local model ref', () => {
    expect(OLLAMA_DEFAULT_MODEL).toBe('ollama:qwen2.5-coder:1.5b');
  });

  it('listModels advertises the FIM-capable coder model', async () => {
    const models = await new OllamaProvider().listModels();
    const coder = models.find((m) => m.id === 'qwen2.5-coder:1.5b');
    expect(coder).toBeDefined();
    expect(coder?.supportsFim).toBe(true);
  });
});

describe('OllamaProvider URL construction', () => {
  it('POSTs native FIM to <host>/v1/completions by default', async () => {
    // No API keys anywhere — Ollama must not require one.
    const seen = mockFetch((_s, url) => {
      expect(url).toBe('http://localhost:11434/v1/completions');
      return jsonOk({ choices: [{ text: ' + 1;' }] });
    });
    const res = await new OllamaProvider().complete({
      model: OLLAMA_DEFAULT_MODEL,
      prefix: 'const x = 1',
      suffix: '\nconsole.log(x);',
      maxTokens: 32,
    });
    expect(res).toEqual({ completion: ' + 1;', nativeFim: true });
    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0].init.body as string) as Record<string, unknown>;
    // The "ollama:" prefix is stripped before hitting the server.
    expect(body).toMatchObject({
      model: 'qwen2.5-coder:1.5b',
      prompt: 'const x = 1',
      suffix: '\nconsole.log(x);',
    });
  });

  it('respects OLLAMA_BASE_URL for completions', async () => {
    process.env.OLLAMA_BASE_URL = 'http://myhost:1234';
    const seen = mockFetch((_s, url) => {
      expect(url).toBe('http://myhost:1234/v1/completions');
      return jsonOk({ choices: [{ text: 'x' }] });
    });
    await new OllamaProvider().complete({
      model: OLLAMA_DEFAULT_MODEL,
      prefix: 'a',
    });
    expect(seen).toHaveLength(1);
  });

  it('never throws "missing API key" — the local daemon needs none', async () => {
    const seen = mockFetch(() => jsonOk({ choices: [{ text: 'x' }] }));
    await expect(
      new OllamaProvider().complete({ model: OLLAMA_DEFAULT_MODEL, prefix: 'a' }),
    ).resolves.toMatchObject({ completion: 'x' });
    expect(seen).toHaveLength(1);
    // Empty bearer, not a missing-key throw.
    const auth = (seen[0].init.headers as Record<string, string>).authorization;
    expect(auth).toBe('Bearer ');
  });
});

describe('OllamaProvider.isAvailable()', () => {
  it('returns false when the connection is refused (Ollama not running)', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(new OllamaProvider().isAvailable()).resolves.toBe(false);
  });

  it('returns false on a non-2xx /api/tags', async () => {
    mockFetch(() => new Response('nope', { status: 500 }));
    await expect(new OllamaProvider().isAvailable()).resolves.toBe(false);
  });

  it('returns true when /api/tags answers ok, hitting the native API path', async () => {
    const seen = mockFetch((_s, url) => {
      expect(url).toBe('http://localhost:11434/api/tags');
      return jsonOk({ models: [] });
    });
    await expect(new OllamaProvider().isAvailable()).resolves.toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('health check honors OLLAMA_BASE_URL', async () => {
    process.env.OLLAMA_BASE_URL = 'http://myhost:1234';
    const seen = mockFetch((_s, url) => {
      expect(url).toBe('http://myhost:1234/api/tags');
      return jsonOk({ models: [] });
    });
    await expect(new OllamaProvider().isAvailable()).resolves.toBe(true);
    expect(seen).toHaveLength(1);
  });
});
