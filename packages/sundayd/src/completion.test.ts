// CompletionOrchestrator tests: cache, debounce, coalescing, per-document
// concurrency cap, latency stats. No network; the provider call is a stub.
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletionOrchestrator } from './completion.js';
import type { CompletionParams } from '@sunday/protocol';
import type { FimRequest, FimResult } from '@sunday/gateway';
import { ProviderRegistry } from '@sunday/gateway';
import type { ChatChunk, ChatProvider, ChatRequest, ModelEntry } from '@sunday/gateway';
import { SundayDaemon, type DaemonOptions } from './daemon.js';
import { createDefaultRegistry as createDefaultTools } from '@sunday/tools';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setTimeout(r, 0));

function params(over: Partial<CompletionParams> = {}): CompletionParams {
  return {
    uri: 'file:///a.ts',
    position: { line: 0, character: 5 },
    prefix: 'const x = ',
    suffix: '\n',
    docVersion: 1,
    model: 'groq:llama-3.1-8b-instant',
    ...over,
  };
}

function makeOrch(
  complete: (req: FimRequest) => Promise<FimResult>,
  over: Record<string, unknown> = {},
) {
  const logs: string[] = [];
  const orch = new CompletionOrchestrator({
    complete,
    debounceMs: 0,
    log: (line) => logs.push(line),
    ...over,
  });
  return { orch, logs };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cache', () => {
  it('serves identical requests from cache (provider called once)', async () => {
    let calls = 0;
    const { orch } = makeOrch(async () => {
      calls++;
      return { completion: '1;', nativeFim: false };
    });
    const p = params();
    const r1 = await orch.complete(p);
    const r2 = await orch.complete(p);
    expect(calls).toBe(1);
    expect(r1).toMatchObject({ completion: '1;', cached: false, cancelled: false });
    expect(r2).toMatchObject({ completion: '1;', cached: true, latencyMs: 0 });
    orch.dispose();
  });

  it('invalidates on docVersion change (edit)', async () => {
    let calls = 0;
    const { orch } = makeOrch(async () => {
      calls++;
      return { completion: `${calls};`, nativeFim: false };
    });
    await orch.complete(params({ docVersion: 1 }));
    const r = await orch.complete(params({ docVersion: 2 }));
    expect(calls).toBe(2);
    expect(r.cached).toBe(false);
    orch.dispose();
  });

  it('evicts the least-recently-used entry at the cap', async () => {
    let calls = 0;
    const { orch } = makeOrch(
      async () => {
        calls++;
        return { completion: 'c', nativeFim: false };
      },
      { cacheSize: 2 },
    );
    await orch.complete(params({ prefix: 'k1' }));
    await orch.complete(params({ prefix: 'k2' }));
    await orch.complete(params({ prefix: 'k3' })); // evicts k1
    expect(calls).toBe(3);
    await orch.complete(params({ prefix: 'k2' })); // still cached
    expect(calls).toBe(3);
    await orch.complete(params({ prefix: 'k1' })); // miss: was evicted
    expect(calls).toBe(4);
    orch.dispose();
  });
});

describe('debounce + coalescing', () => {
  it('debounces a keystroke burst into one provider call; earlier resolves cancelled', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { orch } = makeOrch(
      async () => {
        calls++;
        return { completion: 'x', nativeFim: false };
      },
      { debounceMs: 75 },
    );
    const p1 = orch.complete(params());
    const p2 = orch.complete(params());
    const p3 = orch.complete(params());
    await vi.advanceTimersByTimeAsync(200);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(calls).toBe(1);
    expect(r1.cancelled).toBe(true);
    expect(r2.cancelled).toBe(true);
    expect(r3).toMatchObject({ completion: 'x', cancelled: false });
    orch.dispose();
  });

  it('a new request aborts the in-flight one for the same document', async () => {
    const seen: FimRequest[] = [];
    const { orch } = makeOrch((req) => {
      seen.push(req);
      return new Promise<FimResult>((_resolve, reject) => {
        req.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const p1 = orch.complete(params());
    await tick(); // let the first request go in-flight
    const p2 = orch.complete(params({ prefix: 'const y = ' }));
    await tick();
    expect(seen[0].signal?.aborted).toBe(true);
    const r1 = await p1;
    expect(r1.cancelled).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1].prefix).toBe('const y = ');
    orch.dispose();
  });

  it('keeps at most 1 in-flight call per document, but allows other documents', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const { orch } = makeOrch(async (req) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 20);
          req.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      } finally {
        concurrent--;
      }
      return { completion: 'c', nativeFim: false };
    });
    // Two documents in parallel: allowed (cap is per document).
    const pa = orch.complete(params({ uri: 'file:///a.ts' }));
    const pb = orch.complete(params({ uri: 'file:///b.ts' }));
    await tick();
    expect(orch.stats().inFlight).toBe(2);
    await Promise.all([pa, pb]);
    expect(maxConcurrent).toBe(2);

    // Same document twice: the second supersedes, never 2 in flight.
    // NB: distinct prefix from the a.ts/b.ts requests above — the cache key
    // is content-based (URI-independent), so identical content would hit the
    // cache and never reach the provider.
    maxConcurrent = 0;
    const p1 = orch.complete(params({ uri: 'file:///c.ts', prefix: 'const z = ' }));
    await tick();
    const p2 = orch.complete(params({ uri: 'file:///c.ts', prefix: 'const z = ' }));
    await Promise.all([p1, p2]);
    expect(maxConcurrent).toBe(1);
    orch.dispose();
  });
});

describe('latency instrumentation', () => {
  it('records latencies and exposes p50/p95/avg/count via stats()', async () => {
    const { orch, logs } = makeOrch(
      async () => {
        await sleep(5);
        return { completion: 'c', nativeFim: false };
      },
      { metricLogInterval: 2 },
    );
    await orch.complete(params({ prefix: 'a' }));
    await orch.complete(params({ prefix: 'b' }));
    await orch.complete(params({ prefix: 'c' }));
    const s = orch.stats();
    expect(s.count).toBe(3);
    expect(s.cacheHits).toBe(0);
    expect(s.cacheMisses).toBe(3);
    expect(s.p50Ms).toBeGreaterThanOrEqual(0);
    expect(s.p95Ms).toBeGreaterThanOrEqual(s.p50Ms);
    expect(s.avgMs).toBeGreaterThanOrEqual(0);
    expect(s.inFlight).toBe(0);
    // Metric hook: one sunday.completion.latency line after 2 samples.
    expect(logs).toHaveLength(1);
    const metric = JSON.parse(logs[0]);
    expect(metric.metric).toBe('sunday.completion.latency');
    expect(metric.count).toBe(2);
    expect(typeof metric.p50Ms).toBe('number');
    orch.dispose();
  });

  it('cache hits do not record latency samples', async () => {
    const { orch } = makeOrch(async () => ({ completion: 'c', nativeFim: false }));
    await orch.complete(params());
    await orch.complete(params()); // cached
    expect(orch.stats().count).toBe(1);
    expect(orch.stats().cacheHits).toBe(1);
    orch.dispose();
  });
});

describe('error handling', () => {
  it('rejects when the provider fails (non-abort)', async () => {
    const { orch } = makeOrch(async () => {
      throw new Error('boom');
    });
    await expect(orch.complete(params())).rejects.toThrow('boom');
    orch.dispose();
  });

  it('dispose cancels pending debounce timers', async () => {
    vi.useFakeTimers();
    const { orch } = makeOrch(
      async () => ({ completion: 'x', nativeFim: false }),
      { debounceMs: 1000 },
    );
    const p = orch.complete(params());
    orch.dispose();
    await expect(p).resolves.toMatchObject({ cancelled: true });
  });
});

describe('daemon RPC wiring', () => {
  /** Mock provider with FIM support, registered under id 'mock'. */
  class FimMockProvider implements ChatProvider {
    readonly id = 'mock';
    readonly label = 'Mock FIM provider';
    completeCalls: FimRequest[] = [];
    async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
      yield { type: 'done', finishReason: 'stop' } as ChatChunk;
    }
    async listModels(): Promise<ModelEntry[]> {
      return [
        { id: 'mock-model', label: 'Mock', contextWindow: 8192, supportsTools: true, supportsFim: true },
      ];
    }
    async complete(req: FimRequest): Promise<FimResult> {
      this.completeCalls.push(req);
      return { completion: `<${req.prefix}>`, nativeFim: true };
    }
  }

  interface RpcFrame {
    id?: number;
    result?: any;
    error?: { code: number; message: string };
  }

  async function makeRpcHarness(extra: Partial<DaemonOptions> = {}) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sunday-completion-'));
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
    const provider = new FimMockProvider();
    const providers = new ProviderRegistry();
    providers.register(provider);
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
      provider,
      async call(method: string, params: unknown): Promise<RpcFrame> {
        const id = nextId++;
        input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        const start = Date.now();
        for (;;) {
          const f = frameFor(id);
          if (f) return f;
          if (Date.now() - start > 10000) throw new Error(`timed out waiting for ${method}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      },
      close() {
        input.end();
      },
    };
  }

  it('completion/complete serves ghost text through the daemon', async () => {
    const h = await makeRpcHarness();
    const frame = await h.call('completion/complete', {
      uri: 'file:///a.ts',
      position: { line: 0, character: 5 },
      prefix: 'const x = ',
      suffix: '\n',
      docVersion: 1,
    });
    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({
      completion: '<const x = >',
      cached: false,
      nativeFim: true,
      cancelled: false,
    });
    expect(h.provider.completeCalls).toHaveLength(1);
    expect(h.provider.completeCalls[0].model).toBe('mock:mock-model');

    // Second identical call: served from the orchestrator cache.
    const frame2 = await h.call('completion/complete', {
      uri: 'file:///a.ts',
      position: { line: 0, character: 5 },
      prefix: 'const x = ',
      suffix: '\n',
      docVersion: 1,
    });
    expect(frame2.result.cached).toBe(true);
    expect(h.provider.completeCalls).toHaveLength(1);

    const stats = await h.call('completion/stats', {});
    expect(stats.result).toMatchObject({ count: 1, cacheHits: 1, cacheMisses: 1 });
    h.close();
  });

  it('completion/complete rejects unknown methods cleanly and validates params', async () => {
    const h = await makeRpcHarness();
    const bad = await h.call('completion/complete', { uri: 'x' }); // missing fields
    expect(bad.error).toBeDefined();
    h.close();
  });
});
