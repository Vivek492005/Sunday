// Tests for BrowserViewProvider: the "Agent Browser" panel webview.
// `vscode` is mocked; HostBridge is a manual mock. The webview DOM script is
// not executed here — tests drive the provider side (message routing,
// control-state refresh, 500ms frame polling, disposal). No network, no real
// VS Code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { BROWSER_FRAME_POLL_MS, BrowserViewProvider } from './browserPanel.js';
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
