// Tests for registerBrowserPanelMethods: RPC registration against a fake
// daemon and a fake BrowserPanelManager. Covers the disabled gate on every
// method, passthrough wiring, screencast start on frame, and result
// normalization. No real browserd, no network.
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@sunday/protocol';
import { RpcError } from './transport.js';
import {
  registerBrowserPanelMethods,
  type BrowserPanelDaemon,
  type BrowserPanelManager,
} from './browser-panel.js';
import type { BrowserdManager } from './browserd.js';

// Compile-time contract check: the real BrowserdManager (Worker 1's
// surface) must satisfy the panel's structural interface, so the
// coordinator's `registerBrowserPanelMethods(daemon, browserdManager)` call
// in cli.ts typechecks with no adapter.
const _w1SatisfiesPanel: BrowserPanelManager = null as unknown as BrowserdManager;
void _w1SatisfiesPanel;

function makeDaemon() {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  const daemon: BrowserPanelDaemon = {
    registerMethod: (name, handler) => {
      handlers.set(name, handler);
    },
  };
  return { daemon, handlers };
}

function makeManager(overrides: Partial<BrowserPanelManager> = {}): BrowserPanelManager & { calls: string[] } {
  const calls: string[] = [];
  const manager: BrowserPanelManager = {
    isBrowserEnabled: () => true,
    ensureReady: vi.fn(async () => {
      calls.push('ensureReady');
      return {};
    }),
    rpc: vi.fn(async (method: string, params?: unknown) => {
      calls.push(`rpc:${method}`);
      if (method === 'browser/open') {
        const url = (params as { url: string }).url;
        return { ok: true, url, title: 'T' };
      }
      if (method === 'browser/screenshot') return { png: 'base64png', bytes: 8 };
      if (method === 'browser/close') return { ok: true };
      return { ok: true };
    }),
    startScreencast: vi.fn(async () => {
      calls.push('startScreencast');
    }),
    stopScreencast: vi.fn(async () => {
      calls.push('stopScreencast');
    }),
    latestFrame: vi.fn(async () => {
      calls.push('latestFrame');
      return { data: 'base64jpeg' };
    }),
    takeover: vi.fn(async () => {
      calls.push('takeover');
    }),
    releaseControl: vi.fn(async () => {
      calls.push('releaseControl');
    }),
    controlState: vi.fn(async () => {
      calls.push('controlState');
      return 'agent' as const;
    }),
    ...overrides,
  };
  return { ...manager, calls };
}

const EXPECTED_METHODS = [
  'browser/panel/ensure',
  'browser/panel/open',
  'browser/panel/frame',
  'browser/panel/takeover',
  'browser/panel/release',
  'browser/panel/control',
  'browser/panel/screenshot',
  'browser/panel/close',
];

describe('registerBrowserPanelMethods', () => {
  it('registers exactly the eight browser/panel/* methods', () => {
    const { daemon, handlers } = makeDaemon();
    registerBrowserPanelMethods(daemon, makeManager());
    expect([...handlers.keys()].sort()).toEqual([...EXPECTED_METHODS].sort());
  });

  it('every method returns the disabled error when the browser is off', async () => {
    const { daemon, handlers } = makeDaemon();
    registerBrowserPanelMethods(daemon, makeManager({ isBrowserEnabled: () => false }));
    for (const method of EXPECTED_METHODS) {
      const handler = handlers.get(method)!;
      const params = method === 'browser/panel/open' ? { url: 'https://example.com' } : {};
      await expect(handler(params)).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringContaining('browser is disabled'),
      });
    }
  });

  it('ensure returns ok and calls ensureReady', async () => {
    const { daemon, handlers } = makeDaemon();
    const manager = makeManager();
    registerBrowserPanelMethods(daemon, manager);
    await expect(handlers.get('browser/panel/ensure')!({})).resolves.toEqual({ ok: true });
    expect(manager.calls).toContain('ensureReady');
  });

  it('open passes the url through and normalizes the result', async () => {
    const { daemon, handlers } = makeDaemon();
    const manager = makeManager();
    registerBrowserPanelMethods(daemon, manager);
    await expect(handlers.get('browser/panel/open')!({ url: 'https://example.com' })).resolves.toEqual({
      ok: true,
      url: 'https://example.com',
      title: 'T',
    });
    expect(manager.calls).toContain('rpc:browser/open');
  });

  it('open rejects invalid params with InvalidParams', async () => {
    const { daemon, handlers } = makeDaemon();
    registerBrowserPanelMethods(daemon, makeManager());
    await expect(handlers.get('browser/panel/open')!({ url: '' })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });

  it('frame starts the screencast and returns the latest frame', async () => {
    const { daemon, handlers } = makeDaemon();
    const manager = makeManager();
    registerBrowserPanelMethods(daemon, manager);
    await expect(handlers.get('browser/panel/frame')!({})).resolves.toEqual({ data: 'base64jpeg' });
    expect(manager.calls).toEqual(
      expect.arrayContaining(['ensureReady', 'startScreencast', 'latestFrame']),
    );
  });

  it('frame accepts a raw base64 string from latestFrame', async () => {
    const { daemon, handlers } = makeDaemon();
    registerBrowserPanelMethods(daemon, makeManager({ latestFrame: async () => 'rawbase64' }));
    await expect(handlers.get('browser/panel/frame')!({})).resolves.toEqual({ data: 'rawbase64' });
  });

  it('frame returns null data when no frame is cached yet', async () => {
    const { daemon, handlers } = makeDaemon();
    registerBrowserPanelMethods(daemon, makeManager({ latestFrame: async () => null }));
    await expect(handlers.get('browser/panel/frame')!({})).resolves.toEqual({ data: null });
  });

  it('takeover/release/control report the control state', async () => {
    const { daemon, handlers } = makeDaemon();
    const manager = makeManager({
      takeover: vi.fn(async () => undefined),
      releaseControl: vi.fn(async () => undefined),
      controlState: () => 'user' as const,
    });
    registerBrowserPanelMethods(daemon, manager);
    await expect(handlers.get('browser/panel/takeover')!({})).resolves.toEqual({ control: 'user' });
    await expect(handlers.get('browser/panel/release')!({})).resolves.toEqual({ control: 'agent' });
    await expect(handlers.get('browser/panel/control')!({})).resolves.toEqual({ control: 'user' });
  });

  it('screenshot returns base64 PNG data and errors loudly on empty output', async () => {
    const { daemon, handlers } = makeDaemon();
    registerBrowserPanelMethods(daemon, makeManager());
    await expect(handlers.get('browser/panel/screenshot')!({})).resolves.toEqual({ data: 'base64png' });

    const { daemon: d2, handlers: h2 } = makeDaemon();
    registerBrowserPanelMethods(
      d2,
      makeManager({
        rpc: async (method: string) => (method === 'browser/screenshot' ? { png: '' } : { ok: true }),
      }),
    );
    await expect(h2.get('browser/panel/screenshot')!({})).rejects.toMatchObject({
      code: ErrorCode.InternalError,
    });
  });

  it('screenshot also accepts a raw base64 string', async () => {
    const { daemon, handlers } = makeDaemon();
    registerBrowserPanelMethods(
      daemon,
      makeManager({ rpc: async () => 'rawpng' }),
    );
    await expect(handlers.get('browser/panel/screenshot')!({})).resolves.toEqual({ data: 'rawpng' });
  });

  it('close stops the screencast (best effort) then closes the session', async () => {
    const { daemon, handlers } = makeDaemon();
    const manager = makeManager({
      stopScreencast: vi.fn(async () => {
        throw new Error('no screencast');
      }),
    });
    registerBrowserPanelMethods(daemon, manager);
    await expect(handlers.get('browser/panel/close')!({})).resolves.toEqual({ ok: true });
    expect(manager.calls).toContain('rpc:browser/close');
  });

  it('manager errors surface as InternalError RPC errors', async () => {
    const { daemon, handlers } = makeDaemon();
    registerBrowserPanelMethods(
      daemon,
      makeManager({
        ensureReady: async () => {
          throw new Error('spawn failed');
        },
      }),
    );
    const err = (await handlers.get('browser/panel/ensure')!({}).catch((e) => e)) as RpcError;
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain('spawn failed');
  });
});
