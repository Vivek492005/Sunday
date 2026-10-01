// Tests for registerInlineCompletion: ghost-text provider wiring, config
// gating, and graceful degradation. `vscode` is mocked; HostBridge is a
// manual mock. No DOM, no network, no real VS Code.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  config: { enabled: true, debounceMs: 75, model: 'groq:llama-3.1-8b-instant' } as Record<string, unknown>,
  captured: [] as Array<{ selector: unknown; provider: any }>,
}));

vi.mock('vscode', () => {
  class InlineCompletionItem {
    constructor(
      readonly insertText: string,
      readonly range?: unknown,
    ) {}
  }
  class InlineCompletionList {
    constructor(readonly items: unknown[]) {}
  }
  class Range {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  }
  return {
    workspace: {
      getConfiguration: (_section: string) => ({
        get: (key: string, dflt: unknown) =>
          key in hoisted.config ? hoisted.config[key] : dflt,
      }),
    },
    languages: {
      registerInlineCompletionItemProvider: (selector: unknown, provider: unknown) => {
        hoisted.captured.push({ selector, provider });
        return { dispose: vi.fn() };
      },
    },
    InlineCompletionItem,
    InlineCompletionList,
    Range,
  };
});

import { registerInlineCompletion } from './inlineCompletion.js';
import type { HostBridge } from './hostBridge.js';

function makeBridge() {
  return {
    completionComplete: vi.fn(async (_p: any) => ({
      completion: ' + 1;',
      cached: false,
      nativeFim: false,
      cancelled: false,
      latencyMs: 12,
    })),
  };
}
type MockBridge = ReturnType<typeof makeBridge>;
const asBridge = (b: MockBridge): HostBridge => b as unknown as HostBridge;

function makeDoc(text = 'const x = 1') {
  return {
    uri: { toString: () => 'file:///a.ts' },
    version: 3,
    getText: () => text,
    offsetAt: (pos: { character: number }) => pos.character,
  } as any;
}
const pos = { line: 0, character: 11 } as any;
const token = { isCancellationRequested: false } as any;

beforeEach(() => {
  hoisted.captured.length = 0;
  hoisted.config = { enabled: true, debounceMs: 75, model: 'groq:llama-3.1-8b-instant' };
});

describe('registerInlineCompletion', () => {
  it('registers for all languages and returns a ghost-text item on RPC success', async () => {
    const bridge = makeBridge();
    registerInlineCompletion({ subscriptions: [] } as any, asBridge(bridge));
    const { selector, provider } = hoisted.captured[0];
    expect(selector).toEqual({ pattern: '**' });

    const items = await provider.provideInlineCompletionItems(makeDoc(), pos, {}, token);
    expect(bridge.completionComplete).toHaveBeenCalledTimes(1);
    const rpcParams = bridge.completionComplete.mock.calls[0][0];
    expect(rpcParams).toMatchObject({
      uri: 'file:///a.ts',
      position: { line: 0, character: 11 },
      prefix: 'const x = 1',
      suffix: undefined,
      docVersion: 3,
      model: 'groq:llama-3.1-8b-instant',
    });
    expect(items).toHaveLength(1);
    expect(items[0].insertText).toBe(' + 1;');
  });

  it('sends bounded prefix/suffix around the cursor', async () => {
    const bridge = makeBridge();
    registerInlineCompletion({ subscriptions: [] } as any, asBridge(bridge));
    const { provider } = hoisted.captured[0];
    const text = 'a'.repeat(5000);
    const doc = {
      uri: { toString: () => 'file:///b.ts' },
      version: 1,
      getText: () => text,
      offsetAt: () => 3000,
    } as any;
    await provider.provideInlineCompletionItems(doc, { line: 0, character: 3000 }, {}, token);
    const rpcParams = bridge.completionComplete.mock.calls[0][0];
    expect(rpcParams.prefix).toHaveLength(2000);
    expect(rpcParams.suffix).toHaveLength(500);
  });

  it('returns empty (no RPC) when sunday.completion.enabled is false', async () => {
    hoisted.config.enabled = false;
    const bridge = makeBridge();
    registerInlineCompletion({ subscriptions: [] } as any, asBridge(bridge));
    const { provider } = hoisted.captured[0];
    const items = await provider.provideInlineCompletionItems(makeDoc(), pos, {}, token);
    expect(items).toEqual([]);
    expect(bridge.completionComplete).not.toHaveBeenCalled();
  });

  it('returns empty when the RPC rejects (never breaks typing)', async () => {
    const bridge = makeBridge();
    bridge.completionComplete.mockRejectedValueOnce(new Error('sidecar down'));
    registerInlineCompletion({ subscriptions: [] } as any, asBridge(bridge));
    const { provider } = hoisted.captured[0];
    const items = await provider.provideInlineCompletionItems(makeDoc(), pos, {}, token);
    expect(items).toEqual([]);
  });

  it('returns empty on cancelled or empty completions', async () => {
    const bridge = makeBridge();
    bridge.completionComplete
      .mockResolvedValueOnce({
        completion: '',
        cached: false,
        nativeFim: false,
        cancelled: true,
        latencyMs: 0,
      })
      .mockResolvedValueOnce({
        completion: '',
        cached: false,
        nativeFim: false,
        cancelled: false,
        latencyMs: 5,
      });
    registerInlineCompletion({ subscriptions: [] } as any, asBridge(bridge));
    const { provider } = hoisted.captured[0];
    expect(await provider.provideInlineCompletionItems(makeDoc(), pos, {}, token)).toEqual([]);
    expect(await provider.provideInlineCompletionItems(makeDoc(), pos, {}, token)).toEqual([]);
  });

  it('returns empty on whitespace-only prefix', async () => {
    const bridge = makeBridge();
    registerInlineCompletion({ subscriptions: [] } as any, asBridge(bridge));
    const { provider } = hoisted.captured[0];
    const items = await provider.provideInlineCompletionItems(makeDoc('   \n  '), pos, {}, token);
    expect(items).toEqual([]);
    expect(bridge.completionComplete).not.toHaveBeenCalled();
  });

  it('pushes the disposable into context.subscriptions', () => {
    const subscriptions: any[] = [];
    const disposable = registerInlineCompletion(
      { subscriptions } as any,
      asBridge(makeBridge()),
    );
    expect(subscriptions).toContain(disposable);
  });

  it('returns empty when the cancellation token is already cancelled', async () => {
    const bridge = makeBridge();
    registerInlineCompletion({ subscriptions: [] } as any, asBridge(bridge));
    const { provider } = hoisted.captured[0];
    const items = await provider.provideInlineCompletionItems(
      makeDoc(),
      pos,
      {},
      { isCancellationRequested: true },
    );
    expect(items).toEqual([]);
    expect(bridge.completionComplete).not.toHaveBeenCalled();
  });
});
