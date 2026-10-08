// Tests for BrowserViewProvider: the "Agent Browser" panel webview.
// `vscode` is mocked; HostBridge is a manual mock. The webview DOM script is
// not executed here — tests drive the provider side (message routing,
// control-state refresh, 500ms frame polling, disposal). No network, no real
// VS Code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { BROWSER_FRAME_POLL_MS, BrowserViewProvider } from './browserPanel.js';
import { BROWSER_PLAN_MESSAGE } from './entitlements/browserGating.js';
import {
  resetEntitlementsProviderForTests,
  setEntitlementsProvider,
} from './entitlements/provider.js';
import type { HostBridge } from './hostBridge.js';

/** Flush pending microtasks/promises under fake timers (never hits the 500ms poll tick). */
const flush = () => vi.advanceTimersByTimeAsync(20);

function makeBridge() {
  return {
    browserPanelEnsure: vi.fn(async () => ({ ok: true as const })),
    browserPanelOpen: vi.fn(async (url: string) => ({ ok: true, url, title: 'Example' })),
    browserPanelFrame: vi.fn(async () => ({ data: 'jpegbytes' as string | null })),
    browserPanelTakeover: vi.fn(async () => ({ control: 'user' as const })),
    browserPanelRelease: vi.fn(async () => ({ control: 'agent' as const })),
    browserPanelControl: vi.fn(async (): Promise<{ control: 'agent' | 'user' }> => ({ control: 'agent' })),
    browserPanelScreenshot: vi.fn(async () => ({ data: 'pngbytes' })),
    browserPanelClose: vi.fn(async () => ({ ok: true as const })),
  };
}
type MockBridge = ReturnType<typeof makeBridge>;
const asBridge = (b: MockBridge): HostBridge => b as unknown as HostBridge;

interface MockWebviewView {
  webview: {
    options: any;
    html: string;
    cspSource: string;
    postMessage: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
  };
  visible: boolean;
  onDidDispose: ReturnType<typeof vi.fn>;
  onDidChangeVisibility: ReturnType<typeof vi.fn>;
}

function makeWebviewView(visible = true) {
  const messageHandlers: Array<(m: any) => void> = [];
  const disposeHandlers: Array<() => void> = [];
  const visibilityHandlers: Array<() => void> = [];
  const webview = {
    options: undefined as any,
    html: '',
    cspSource: 'https://null',
    postMessage: vi.fn(),
    onDidReceiveMessage: vi.fn((h: (m: any) => void) => {
      messageHandlers.push(h);
      return { dispose: () => undefined };
    }),
  };
  const view: MockWebviewView = {
    webview,
    visible,
    onDidDispose: vi.fn((h: () => void) => {
      disposeHandlers.push(h);
      return { dispose: () => undefined };
    }),
    onDidChangeVisibility: vi.fn((h: () => void) => {
      visibilityHandlers.push(h);
      return { dispose: () => undefined };
    }),
  };
  const sendToProvider = (msg: unknown) => {
    for (const h of messageHandlers) h(msg);
  };
  const fireDispose = () => {
    for (const h of disposeHandlers) h();
  };
  const setVisible = (v: boolean) => {
    view.visible = v;
    for (const h of visibilityHandlers) h();
  };
  return { view, webview, sendToProvider, fireDispose, setVisible };
}

function makeProvider(bridge: MockBridge) {
  const logs: string[] = [];
  const provider = new BrowserViewProvider({
    getBridge: () => asBridge(bridge),
    ensureBridge: async () => asBridge(bridge),
    log: (m) => logs.push(m),
  });
  return { provider, logs };
}

function lastMessageOfType(webview: { postMessage: ReturnType<typeof vi.fn> }, type: string) {
  const calls = webview.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === type);
  return calls[calls.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BrowserViewProvider', () => {
  it('serves accessible panel markup: labelled URL input, alert banner, status badge', () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const view = makeWebviewView();
    provider.resolveWebviewView(view.view as never);
    const html: string = view.webview.html;
    // Placeholder text is not a label for screen readers.
    expect(html).toContain('aria-label="Browser URL"');
    // Error/notice banner is announced.
    expect(html).toContain('id="banner" role="alert"');
    // Control handover state is a live status, not a decorative span.
    expect(html).toContain('role="status"');
    // Controls that matter have visible text or titles.
    for (const label of ['Take over', 'Resume agent', 'Screenshot', 'Open', 'Reload', 'Close session']) {
      expect(html).toContain(label);
    }
    provider.dispose();
  });
  it('resolves the view with scripts enabled and posts the control state', async () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { view, webview } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();

    expect(webview.options).toEqual({ enableScripts: true });
    expect(webview.html).toContain('sunday/browser/takeover');
    expect(webview.html).toContain('id="liveImg"');
    expect(bridge.browserPanelControl).toHaveBeenCalled();
    expect(lastMessageOfType(webview, 'sunday/browser/state')).toEqual({
      type: 'sunday/browser/state',
      state: { control: 'agent', url: '' },
    });
    provider.dispose();
  });

  it('take-over message routes to browserPanelTakeover and refreshes state', async () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { view, webview, sendToProvider } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();

    bridge.browserPanelControl.mockResolvedValueOnce({ control: 'user' as const });
    sendToProvider({ type: 'sunday/browser/takeover' });
    await flush();

    expect(bridge.browserPanelTakeover).toHaveBeenCalledTimes(1);
    expect(lastMessageOfType(webview, 'sunday/browser/state')).toEqual({
      type: 'sunday/browser/state',
      state: { control: 'user', url: '' },
    });
    provider.dispose();
  });

  it('release message routes to browserPanelRelease', async () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { sendToProvider, view } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();

    sendToProvider({ type: 'sunday/browser/release' });
    await flush();
    expect(bridge.browserPanelRelease).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('open message routes to browserPanelOpen with the URL', async () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { sendToProvider, view, webview } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();

    sendToProvider({ type: 'sunday/browser/open', url: 'https://example.com' });
    await flush();
    expect(bridge.browserPanelOpen).toHaveBeenCalledWith('https://example.com');
    expect(lastMessageOfType(webview, 'sunday/browser/opened')).toMatchObject({
      url: 'https://example.com',
    });
    provider.dispose();
  });

  it('screenshot message posts the captured image back to the webview', async () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { sendToProvider, view, webview } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();

    sendToProvider({ type: 'sunday/browser/screenshot' });
    await flush();
    expect(bridge.browserPanelScreenshot).toHaveBeenCalledTimes(1);
    const msg = lastMessageOfType(webview, 'sunday/browser/screenshot');
    expect(msg.data).toBe('pngbytes');
    expect(msg.ts).toEqual(expect.any(Number));
    provider.dispose();
  });

  it('close message routes to browserPanelClose and posts closed', async () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { sendToProvider, view, webview } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();

    sendToProvider({ type: 'sunday/browser/close' });
    await flush();
    expect(bridge.browserPanelClose).toHaveBeenCalledTimes(1);
    expect(lastMessageOfType(webview, 'sunday/browser/closed')).toEqual({
      type: 'sunday/browser/closed',
    });
    provider.dispose();
  });

  it('bridge errors are surfaced to the webview as error messages', async () => {
    const bridge = makeBridge();
    bridge.browserPanelOpen.mockRejectedValueOnce(new Error('browser is disabled (set sunday.browser.enabled to true)'));
    const { provider } = makeProvider(bridge);
    const { sendToProvider, view, webview } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();

    sendToProvider({ type: 'sunday/browser/open', url: 'https://example.com' });
    await flush();
    expect(lastMessageOfType(webview, 'sunday/browser/error')).toMatchObject({
      message: expect.stringContaining('browser is disabled'),
    });
    provider.dispose();
  });

  it('polls browser/panel/frame every 500ms while visible and stops on dispose', async () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { view, webview, fireDispose } = makeWebviewView(true);
    provider.resolveWebviewView(view as any);
    await flush();
    const framesBefore = bridge.browserPanelFrame.mock.calls.length;

    await vi.advanceTimersByTimeAsync(BROWSER_FRAME_POLL_MS * 3);
    expect(bridge.browserPanelFrame.mock.calls.length).toBe(framesBefore + 3);
    expect(lastMessageOfType(webview, 'sunday/browser/frame')).toEqual({
      type: 'sunday/browser/frame',
      data: 'jpegbytes',
    });

    fireDispose();
    const callsAtDispose = bridge.browserPanelFrame.mock.calls.length;
    await vi.advanceTimersByTimeAsync(BROWSER_FRAME_POLL_MS * 5);
    expect(bridge.browserPanelFrame.mock.calls.length).toBe(callsAtDispose);
  });

  it('does not poll while the view is hidden, and resumes when shown', async () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { view, setVisible } = makeWebviewView(false);
    provider.resolveWebviewView(view as any);
    await flush();

    await vi.advanceTimersByTimeAsync(BROWSER_FRAME_POLL_MS * 4);
    expect(bridge.browserPanelFrame).not.toHaveBeenCalled();

    setVisible(true);
    await vi.advanceTimersByTimeAsync(BROWSER_FRAME_POLL_MS * 2);
    expect(bridge.browserPanelFrame.mock.calls.length).toBe(2);
    provider.dispose();
  });

  it('a null frame is forwarded as-is (webview keeps the last image)', async () => {
    const bridge = makeBridge();
    bridge.browserPanelFrame.mockResolvedValue({ data: null });
    const { provider } = makeProvider(bridge);
    const { view, webview } = makeWebviewView(true);
    provider.resolveWebviewView(view as any);
    await flush();

    await vi.advanceTimersByTimeAsync(BROWSER_FRAME_POLL_MS);
    expect(lastMessageOfType(webview, 'sunday/browser/frame')).toEqual({
      type: 'sunday/browser/frame',
      data: null,
    });
    provider.dispose();
  });

  it('frame poll failures are surfaced once, not on every tick', async () => {
    const bridge = makeBridge();
    bridge.browserPanelFrame.mockRejectedValue(new Error('boom'));
    const { provider } = makeProvider(bridge);
    const { view, webview } = makeWebviewView(true);
    provider.resolveWebviewView(view as any);
    await flush();

    await vi.advanceTimersByTimeAsync(BROWSER_FRAME_POLL_MS * 4);
    const errors = webview.postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === 'sunday/browser/error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('boom');
    provider.dispose();
  });

  it('notifyBridgeChanged re-queries the control state', async () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { view, webview } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();
    const callsBefore = bridge.browserPanelControl.mock.calls.length;

    provider.notifyBridgeChanged();
    await flush();
    expect(bridge.browserPanelControl.mock.calls.length).toBe(callsBefore + 1);
    expect(lastMessageOfType(webview, 'sunday/browser/state')).toBeDefined();
    provider.dispose();
  });

  it('takeOver() calls takeover and refreshes state', async () => {
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { view, webview } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();

    bridge.browserPanelControl.mockResolvedValueOnce({ control: 'user' as const });
    await provider.takeOver();
    expect(bridge.browserPanelTakeover).toHaveBeenCalledTimes(1);
    expect(lastMessageOfType(webview, 'sunday/browser/state')).toEqual({
      type: 'sunday/browser/state',
      state: { control: 'user', url: '' },
    });
    provider.dispose();
  });
});

describe('BrowserViewProvider entitlement gate (Task 7)', () => {
  function setView(browserEnabled: boolean) {
    const view = {
      user_id: 'u-test',
      plan: 'basic',
      status: 'active',
      renews_at: null,
      entitlements: {
        'managed_models.enabled': true,
        'managed_models.daily_requests': 200,
        'orchestration.max_feature_agents': 1,
        'orchestration.parallel': false,
        'browser_agent.enabled': browserEnabled,
        'browser_agent.daily_sessions': 0,
        'codebase_index.max_repo_mb': 100,
        'autocomplete.managed_route': false,
        'scheduler.priority_class': 'standard',
        'support.tier': 'community',
      },
      cached_at: new Date().toISOString(),
      valid_until: new Date().toISOString(),
    };
    setEntitlementsProvider({
      getEntitlements: async () => ({ view: view as any, source: 'cache' as const }),
      getCachedSync: () => view as any,
      refresh: async () => ({ view: view as any, source: 'cache' as const }),
      clear: () => undefined,
    });
  }

  beforeEach(() => {
    resetEntitlementsProviderForTests();
  });

  afterEach(() => {
    resetEntitlementsProviderForTests();
  });

  it('posts the entitlement-disabled state and never touches the bridge when gated', async () => {
    setView(false);
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { view, webview } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();
    // No bridge call at all — browserd must not start for a gated plan.
    expect(bridge.browserPanelControl).not.toHaveBeenCalled();
    expect(lastMessageOfType(webview, 'sunday/browser/state')).toEqual({
      type: 'sunday/browser/state',
      state: {
        control: 'unknown',
        url: '',
        entitlementDisabled: true,
        error: BROWSER_PLAN_MESSAGE,
      },
    });
    provider.dispose();
  });

  it('blocks browser actions with the upsell message instead of opening', async () => {
    setView(false);
    const bridge = makeBridge();
    const { provider, logs } = makeProvider(bridge);
    const { view, webview, sendToProvider } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();
    sendToProvider({ type: 'sunday/browser/open', url: 'https://example.com' });
    await flush();
    expect(bridge.browserPanelOpen).not.toHaveBeenCalled();
    expect(lastMessageOfType(webview, 'sunday/browser/error')).toMatchObject({
      type: 'sunday/browser/error',
      message: BROWSER_PLAN_MESSAGE,
    });
    expect(logs.some((m) => m.includes('browser view'))).toBe(true);
    provider.dispose();
  });

  it('takeOver throws the upsell message when gated (command safety net)', async () => {
    setView(false);
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    await expect(provider.takeOver()).rejects.toThrow(BROWSER_PLAN_MESSAGE);
    expect(bridge.browserPanelTakeover).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('fails open when no entitlements are cached yet', async () => {
    // No provider registered at all — the panel behaves as before.
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { view, webview } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();
    expect(bridge.browserPanelControl).toHaveBeenCalled();
    expect(lastMessageOfType(webview, 'sunday/browser/state')).toEqual({
      type: 'sunday/browser/state',
      state: { control: 'agent', url: '' },
    });
    provider.dispose();
  });

  it('works normally when the plan includes the browser agent', async () => {
    setView(true);
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { view, webview, sendToProvider } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();
    sendToProvider({ type: 'sunday/browser/open', url: 'https://example.com' });
    await flush();
    expect(bridge.browserPanelOpen).toHaveBeenCalledWith('https://example.com');
    expect(lastMessageOfType(webview, 'sunday/browser/opened')).toMatchObject({
      type: 'sunday/browser/opened',
      url: 'https://example.com',
    });
    provider.dispose();
  });

  it('fails open when the cached read throws', async () => {
    setEntitlementsProvider({
      getEntitlements: async () => {
        throw new Error('gateway down');
      },
      getCachedSync: () => {
        throw new Error('cache corrupt');
      },
      refresh: async () => {
        throw new Error('gateway down');
      },
      clear: () => undefined,
    });
    const bridge = makeBridge();
    const { provider } = makeProvider(bridge);
    const { view, webview } = makeWebviewView();
    provider.resolveWebviewView(view as any);
    await flush();
    expect(bridge.browserPanelControl).toHaveBeenCalled();
    expect(lastMessageOfType(webview, 'sunday/browser/state')).toEqual({
      type: 'sunday/browser/state',
      state: { control: 'agent', url: '' },
    });
    provider.dispose();
  });
});
