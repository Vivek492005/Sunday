// F14 — Local-first Chat Mode tests. `fetch` is mocked; no network,
// no real Ollama required.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROUTE_POLICIES,
  policyForTaskClass,
} from './models.js';
import { OllamaProvider } from './providers.js';
import { ProviderRegistry } from './registry.js';
import { Router } from './router.js';
import { MockChatProvider } from './testing.js';
import type { ChatChunk } from './types.js';
import {
  LocalOnlyUnavailableError,
  getLocalChatConfig,
  isAgentLoopAllowed,
  isLocalChatEnabled,
  probeLocalCapability,
  probeOllama,
  resetLocalChatConfig,
  setLocalChatConfig,
  type ProbeChat,
} from './local-chat.js';

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  vi.stubGlobal('fetch', async (url: unknown, init: unknown) => {
    return handler(String(url), init as RequestInit);
  });
}

const jsonOk = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.SUNDAY_LOCAL_CHAT;
  delete process.env.SUNDAY_LOCAL_MODEL;
  resetLocalChatConfig();
});

// ---------------------------------------------------------------------------
// /api/tags discovery
// ---------------------------------------------------------------------------

describe('OllamaProvider model discovery', () => {
  it('discovers installed models from /api/tags', async () => {
    mockFetch((url) => {
      expect(url).toBe('http://localhost:11434/api/tags');
      return jsonOk({
        models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5-coder:1.5b' }],
      });
    });
    const models = await new OllamaProvider().listModels();
    expect(models.map((m) => m.id)).toEqual(['llama3.1:8b', 'qwen2.5-coder:1.5b']);
    expect(models[0].label).toContain('Ollama, local');
    // Known-model context window from the data table.
    expect(models.find((m) => m.id === 'llama3.1:8b')?.contextWindow).toBe(131072);
    // Conservative default: small local models are not advertised as
    // tool-capable — the capability probe decides that.
    expect(models.every((m) => m.supportsTools === false)).toBe(true);
  });

  it('falls back to the static list when Ollama is down (graceful)', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const models = await new OllamaProvider().listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('qwen2.5-coder:1.5b');
  });

  it('falls back to the static list on a bad /api/tags payload', async () => {
    mockFetch(() => jsonOk({ nope: true }));
    const models = await new OllamaProvider().listModels();
    expect(models).toHaveLength(1);
  });

  it('discoverModels throws on transport failure (listModels catches it)', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(new OllamaProvider().discoverModels()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

function fakeChat(chunks: ChatChunk[]): ProbeChat {
  return async function* () {
    for (const c of chunks) yield c;
  };
}

const toolCallChunks: ChatChunk[] = [
  {
    type: 'tool-call',
    call: { id: 'call-1', name: 'get_weather', arguments: { city: 'Paris' } },
  },
  { type: 'done', finishReason: 'tool_calls' },
];

const jsonChunks: ChatChunk[] = [
  { type: 'text-delta', delta: '{"status": "ok", "count": 3}' },
  { type: 'done', finishReason: 'stop' },
];

const editChunks: ChatChunk[] = [
  { type: 'text-delta', delta: '```js\nfunction inc(x) { return x + 1; }\n```' },
  { type: 'done', finishReason: 'stop' },
];

function scriptedChat(scripts: ChatChunk[][]): ProbeChat {
  const queue = scripts.map((s) => [...s]);
  return async function* () {
    const chunks = queue.shift() ?? [{ type: 'done', finishReason: 'stop' } as ChatChunk];
    for (const c of chunks) yield c;
  };
}

describe('probeLocalCapability', () => {
  it('marks agentCapable=true when all three checks pass', async () => {
    const res = await probeLocalCapability(
      scriptedChat([toolCallChunks, jsonChunks, editChunks]),
      'ollama:qwen2.5-coder:1.5b',
      { timeoutMs: 5000 },
    );
    expect(res.agentCapable).toBe(true);
    expect(res.checks.toolCall.pass).toBe(true);
    expect(res.checks.json.pass).toBe(true);
    expect(res.checks.editApply.pass).toBe(true);
    expect(res.probedAt).toBeTruthy();
  });

  it('fails when no tool call is emitted', async () => {
    const res = await probeLocalCapability(
      scriptedChat([
        [{ type: 'text-delta', delta: 'The weather in Paris is nice.' } as ChatChunk],
        jsonChunks,
        editChunks,
      ]),
      'ollama:x',
      { timeoutMs: 5000 },
    );
    expect(res.agentCapable).toBe(false);
    expect(res.checks.toolCall.pass).toBe(false);
  });

  it('fails when the JSON answer is malformed', async () => {
    const res = await probeLocalCapability(
      scriptedChat([
        toolCallChunks,
        [{ type: 'text-delta', delta: 'sure thing boss' } as ChatChunk],
        editChunks,
      ]),
      'ollama:x',
      { timeoutMs: 5000 },
    );
    expect(res.agentCapable).toBe(false);
    expect(res.checks.json.pass).toBe(false);
  });

  it('fails when the edit is not applied', async () => {
    const res = await probeLocalCapability(
      scriptedChat([
        toolCallChunks,
        jsonChunks,
        [{ type: 'text-delta', delta: 'function inc(x) { return x + 2; }' } as ChatChunk],
      ]),
      'ollama:x',
      { timeoutMs: 5000 },
    );
    expect(res.agentCapable).toBe(false);
    expect(res.checks.editApply.pass).toBe(false);
  });

  it('never throws for model misbehaviour — it reports agentCapable=false', async () => {
    const res = await probeLocalCapability(fakeChat([]), 'ollama:x', { timeoutMs: 1000 });
    expect(res.agentCapable).toBe(false);
  });
});

class DownOllama extends OllamaProvider {
  override async isAvailable(): Promise<boolean> {
    return false;
  }
}

describe('probeOllama', () => {
  it('returns agentCapable=false without throwing when Ollama is down', async () => {
    const res = await probeOllama(new DownOllama(), { timeoutMs: 1000 });
    expect(res.agentCapable).toBe(false);
    expect(res.checks.toolCall.detail).toMatch(/not reachable/);
    // The outcome is recorded in the module config.
    expect(getLocalChatConfig().agentCapable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('local chat config', () => {
  it('is disabled by default (opt-in, ADR-004 respected)', () => {
    expect(isLocalChatEnabled()).toBe(false);
  });

  it('opts in via SUNDAY_LOCAL_CHAT=1', () => {
    process.env.SUNDAY_LOCAL_CHAT = '1';
    resetLocalChatConfig();
    expect(isLocalChatEnabled()).toBe(true);
  });

  it('agent loop requires enabled + probed-capable', () => {
    setLocalChatConfig({ enabled: true, agentCapable: true });
    expect(isAgentLoopAllowed()).toBe(true);
    setLocalChatConfig({ agentCapable: false });
    expect(isAgentLoopAllowed()).toBe(false);
    setLocalChatConfig({ enabled: false, agentCapable: true });
    expect(isAgentLoopAllowed()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Router: privacy + local-first task classes
// ---------------------------------------------------------------------------

function cloudProvider(spy: { calls: number }) {
  const p = new MockChatProvider({
    id: 'sunday',
    scripts: [[{ type: 'text-delta', delta: 'hi' }, { type: 'done', finishReason: 'stop' } as ChatChunk]],
  });
  const orig = p.chat.bind(p);
  p.chat = async function* (req) {
    spy.calls++;
    yield* orig(req);
  };
  return p;
}

describe('router privacy=local-only', () => {
  it('never touches a cloud provider when ollama fails', async () => {
    const cloud = { calls: 0 };
    const registry = new ProviderRegistry();
    const ollamaSpy = { calls: 0 };
    const ollama = new MockChatProvider({ id: 'ollama', forceStatus: 500 });
    const origChat = ollama.chat.bind(ollama);
    ollama.chat = async function* (req) {
      ollamaSpy.calls++;
      yield* origChat(req);
    };
    registry.register(ollama);
    registry.register(cloudProvider(cloud));
    const router = new Router(registry);

    await expect(
      router.chat({ model: 'ollama:qwen2.5-coder:1.5b', messages: [], privacy: 'local-only' }),
    ).rejects.toThrow();
    expect(ollamaSpy.calls).toBe(1);
    // THE privacy guarantee: zero cloud calls.
    expect(cloud.calls).toBe(0);
  });

  it('throws LocalOnlyUnavailableError when ollama is not registered', async () => {
    const registry = new ProviderRegistry();
    registry.register(new MockChatProvider({ id: 'sunday' }));
    const router = new Router(registry);
    await expect(
      router.chat({ model: 'ollama:qwen2.5-coder:1.5b', messages: [], privacy: 'local-only' }),
    ).rejects.toBeInstanceOf(LocalOnlyUnavailableError);
  });

  it('records privacy in the routing log', async () => {
    const registry = new ProviderRegistry();
    registry.register(new MockChatProvider({ id: 'sunday' }));
    const router = new Router(registry);
    await expect(
      router.chat({ model: 'ollama:x', messages: [], privacy: 'local-only' }),
    ).rejects.toBeInstanceOf(LocalOnlyUnavailableError);
    const entries = router.routingLog.entries();
    const start = entries.find((e) => e.kind === 'route-start');
    expect(start?.reason).toContain('privacy=local-only');
  });
});

class UnavailableOllama extends MockChatProvider {
  readonly ollamaChatCalls = { n: 0 };
  constructor(opts: { forceStatus?: number } = {}) {
    super({ id: 'ollama', ...opts });
  }
  async isAvailable(): Promise<boolean> {
    return false;
  }
}

describe('router unavailable-primary skip (local-first task classes)', () => {
  it('skips a down Ollama and serves ask via the cloud fallback', async () => {
    const cloud = { calls: 0 };
    const registry = new ProviderRegistry();
    const ollama = new UnavailableOllama();
    const origChat = ollama.chat.bind(ollama);
    ollama.chat = async function* (req) {
      ollama.ollamaChatCalls.n++;
      yield* origChat(req);
    };
    registry.register(ollama);
    registry.register(cloudProvider(cloud));
    const router = new Router(registry, undefined, undefined, undefined, undefined, {
      routePolicies: DEFAULT_ROUTE_POLICIES,
    });

    const routed = await router.chat({ model: 'ignored', messages: [], taskClass: 'ask' });
    // First chunk consumed to prove it was served.
    const it = routed.stream[Symbol.asyncIterator]();
    await it.next();
    expect(cloud.calls).toBe(1);
    expect(ollama.ollamaChatCalls.n).toBe(0);
    expect(routed.provider.id).toBe('sunday');
  });

  it('does not skip when downgrade=never (privacy path stays strict)', async () => {
    const cloud = { calls: 0 };
    const registry = new ProviderRegistry();
    // Ollama reports unavailable AND its chat fails: with privacy=local-only
    // the router must attempt ollama (no skip) and surface the error —
    // never silently serve from cloud.
    const ollama = new UnavailableOllama({ forceStatus: 500 });
    registry.register(ollama);
    registry.register(cloudProvider(cloud));
    const router = new Router(registry, undefined, undefined, undefined, undefined, {
      routePolicies: DEFAULT_ROUTE_POLICIES,
    });
    await expect(
      router.chat({ model: 'ollama:x', messages: [], taskClass: 'ask', privacy: 'local-only' }),
    ).rejects.toThrow();
    expect(cloud.calls).toBe(0);
  });
});

describe('DEFAULT_ROUTE_POLICIES local-first entries', () => {
  for (const cls of ['ask', 'explain', 'inline-edit'] as const) {
    it(`routes '${cls}' to ollama primary with a cloud fallback`, () => {
      const p = policyForTaskClass(DEFAULT_ROUTE_POLICIES, cls);
      expect(p).toBeDefined();
      expect(p?.primary).toMatch(/^ollama:/);
      expect(p?.fallbacks.length).toBeGreaterThan(0);
      expect(p?.downgrade).toBe('auto');
    });
  }
});
