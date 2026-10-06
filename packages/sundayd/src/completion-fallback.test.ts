// Local Model slice: completion fallback tests. The daemon tries the `ollama`
// provider first (3s timeout) when localModelEnabled, and falls back SILENTLY
// to the API provider chain on any failure. RPC-level harness; no network.
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@sunday/gateway';
import type { ChatChunk, ChatProvider, ChatRequest, FimRequest, FimResult, ModelEntry } from '@sunday/gateway';
import { SundayDaemon, type DaemonOptions } from './daemon.js';
import { createDefaultRegistry as createDefaultTools } from '@sunday/tools';

/** API-side mock provider (id 'mock'). */
class ApiMockProvider implements ChatProvider {
  readonly id = 'mock';
  readonly label = 'Mock API provider';
  completeCalls: FimRequest[] = [];
  async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
    yield { type: 'done', finishReason: 'stop' } as ChatChunk;
  }
  async listModels(): Promise<ModelEntry[]> {
    return [{ id: 'mock-model', label: 'Mock', contextWindow: 8192, supportsTools: true, supportsFim: true }];
  }
  async complete(req: FimRequest): Promise<FimResult> {
    this.completeCalls.push(req);
    return { completion: `<api:${req.prefix}>`, nativeFim: false };
  }
}

/** Ollama-side mock provider (id 'ollama'); behavior is injectable per test. */
class OllamaMockProvider implements ChatProvider {
  readonly id = 'ollama';
  readonly label = 'Mock Ollama';
  completeCalls: FimRequest[] = [];
  /** 'ok' | 'throw' | 'hang' (until signal aborts). */
  behavior: 'ok' | 'throw' | 'hang' = 'ok';
  async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
    yield { type: 'done', finishReason: 'stop' } as ChatChunk;
  }
  async listModels(): Promise<ModelEntry[]> {
    return [{ id: 'qwen2.5-coder:1.5b', label: 'Mock', contextWindow: 32768, supportsTools: false, supportsFim: true }];
  }
  async complete(req: FimRequest): Promise<FimResult> {
    this.completeCalls.push(req);
    if (this.behavior === 'throw') throw new Error('ollama not running');
    if (this.behavior === 'hang') {
      await new Promise<void>((_, reject) => {
        req.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
        // Never resolves on its own — the daemon's 3s timeout must abort us.
      });
    }
    return { completion: `<ollama:${req.prefix}>`, nativeFim: true };
  }
}

interface RpcFrame {
  id?: number;
  result?: any;
  error?: { code: number; message: string };
}

async function makeHarness(extra: Partial<DaemonOptions> = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sunday-local-model-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: RpcFrame[] = [];
  let buf = '';
  output.on('data', (d: Buffer) => {
    buf += d.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        try {
          frames.push(JSON.parse(line) as RpcFrame);
        } catch {
          /* stderr diagnostics or partial line */
        }
      }
    }
  });
  const ollama = new OllamaMockProvider();
  const api = new ApiMockProvider();
  const providers = new ProviderRegistry();
  providers.register(api);
  providers.register(ollama);
  const daemon = new SundayDaemon(
    {
      sessionsDir: path.join(dir, 'sessions'),
      defaultModel: 'mock:mock-model',
      completionModel: 'mock:mock-model',
      providers,
      tools: createDefaultTools(),
      onShutdown: () => undefined,
      onStdinClose: () => undefined,
      ...extra,
    },
    input,
    output,
  );
  await daemon.start();
  let nextId = 1;
  const frameFor = (id: number) => frames.find((f) => f.id === id);
  return {
    ollama,
    api,
    async call(method: string, params: unknown): Promise<RpcFrame> {
      const id = nextId++;
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const start = Date.now();
      for (;;) {
        const f = frameFor(id);
        if (f) return f;
        if (Date.now() - start > 15000) throw new Error(`timed out waiting for ${method}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close() {
      input.end();
    },
  };
}

const completionParams = (uri: string) => ({
  uri,
  position: { line: 0, character: 5 },
  prefix: 'const x = ',
  suffix: '\n',
  docVersion: 1,
});

afterEach(() => {
  delete process.env.SUNDAY_LOCAL_MODEL_ENABLED;
});

describe('local model fallback (completion/complete)', () => {
  it('flag off (default): ollama is never consulted, API serves directly', async () => {
    const h = await makeHarness(); // localModelEnabled unset → false
    const frame = await h.call('completion/complete', completionParams('file:///off.ts'));
    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({ completion: '<api:const x = >' });
    expect(h.ollama.completeCalls).toHaveLength(0);
    expect(h.api.completeCalls).toHaveLength(1);
    h.close();
  });

  it('flag on + ollama succeeds: local result is used, API untouched', async () => {
    const h = await makeHarness({ localModelEnabled: true });
    const frame = await h.call('completion/complete', completionParams('file:///on.ts'));
    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({ completion: '<ollama:const x = >', nativeFim: true });
    expect(h.ollama.completeCalls).toHaveLength(1);
    // The daemon pins the local request to the configured local model.
    expect(h.ollama.completeCalls[0].model).toBe('ollama:qwen2.5-coder:1.5b');
    expect(h.api.completeCalls).toHaveLength(0);
    h.close();
  });

  it('flag on + ollama throws: silently falls back to the API provider', async () => {
    const h = await makeHarness({ localModelEnabled: true });
    h.ollama.behavior = 'throw';
    const frame = await h.call('completion/complete', completionParams('file:///throw.ts'));
    // Silent: no user-visible error, the API result comes back.
    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({ completion: '<api:const x = >', cancelled: false });
    expect(h.ollama.completeCalls).toHaveLength(1);
    expect(h.api.completeCalls).toHaveLength(1);
    h.close();
  });

  it('flag on + ollama hangs: 3s timeout aborts it and falls back to API', async () => {
    const h = await makeHarness({ localModelEnabled: true });
    h.ollama.behavior = 'hang';
    const started = Date.now();
    const frame = await h.call('completion/complete', completionParams('file:///hang.ts'));
    const elapsed = Date.now() - started;
    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({ completion: '<api:const x = >' });
    // The daemon gave up on the hung local model after ~3s (debounce adds a bit).
    expect(elapsed).toBeLessThan(10000);
    expect(h.api.completeCalls).toHaveLength(1);
    h.close();
  }, 20000);

  it('SUNDAY_LOCAL_MODEL_ENABLED=1 enables local-first without the option', async () => {
    process.env.SUNDAY_LOCAL_MODEL_ENABLED = '1';
    const h = await makeHarness();
    const frame = await h.call('completion/complete', completionParams('file:///env.ts'));
    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({ completion: '<ollama:const x = >' });
    expect(h.api.completeCalls).toHaveLength(0);
    h.close();
  });
});
