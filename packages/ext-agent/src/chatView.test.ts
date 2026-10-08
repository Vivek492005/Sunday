// Tests for ChatViewProvider: webview message routing, event forwarding,
// Relay passthrough, and disposal. `vscode` is mocked; HostBridge is a manual
// mock. No DOM, no network, no real VS Code.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => p, scheme: 'file' }),
  },
  workspace: {
    getConfiguration: (_section?: string) => ({
      get: (_key: string, def: unknown) => def,
    }),
  },
  window: {
    showInformationMessage: vi.fn(),
  },
}));

import { ChatViewProvider, resolveChatDistDir } from './chatView.js';
import {
  resetEntitlementsProviderForTests,
  setEntitlementsProvider,
} from './entitlements/provider.js';
import { usageKeyFor } from './entitlements/usage.js';
import type { HostBridge } from './hostBridge.js';

type MockBridge = ReturnType<typeof makeBridge>;
const asBridge = (b: MockBridge): HostBridge => b as unknown as HostBridge;

const flush = () => new Promise((r) => setTimeout(r, 20));

function makeBridge() {
  const listeners = new Set<(n: any) => void>();
  return {
    listeners,
    sessionCreate: vi.fn(async (_p: any) => ({ session: { id: 'sess-1' } })),
    chatSend: vi.fn(async (_p: any) => ({ turnId: 'turn-1' })),
    cancelActiveTurn: vi.fn(async () => true),
    modelsList: vi.fn(async () => ({ models: [{ id: 'm1', provider: 'groq', label: 'M1' }] })),
    onChatEvent: vi.fn((l: (n: any) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
  };
}

function makeWebview() {
  const handlers: Array<(m: any) => void> = [];
  const webview = {
    options: undefined as any,
    html: '',
    cspSource: 'https://null',
    asWebviewUri: (u: { toString(): string }) => ({ toString: () => `webview://${u.toString()}` }),
    postMessage: vi.fn(),
    onDidReceiveMessage: vi.fn((h: (m: any) => void) => {
      handlers.push(h);
      return { dispose: () => undefined };
    }),
  };
  const view = { webview, onDidDispose: vi.fn() };
  return { view, webview, handlers };
}

/** Fake extension layout: <tmp>/ext-agent + <tmp>/ui-chat/dist/index.html. */
function makeExtLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-chatview-'));
  const extensionPath = path.join(root, 'ext-agent');
  const distDir = path.join(root, 'ui-chat', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    '<!doctype html><html><head><title>t</title>' +
      '<script type="module" src="./assets/app.js"></script>' +
      '<link rel="stylesheet" href="./assets/app.css">' +
      '</head><body><div id="root"></div></body></html>',
  );
  return { root, extensionPath };
}

function makeProvider(bridge: ReturnType<typeof makeBridge>, extensionPath: string) {
  const logs: string[] = [];
  const store = new Map<string, unknown>();
  const provider = new ChatViewProvider({
    extensionPath,
    getBridge: () => asBridge(bridge),
    ensureBridge: async () => asBridge(bridge),
    getCwd: () => '/fake/cwd',
    globalState: {
      get: <T,>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
    log: (m) => logs.push(m),
  });
  return { provider, logs, store };
}

describe('resolveChatDistDir', () => {
  it('prefers the dev-checkout candidate containing index.html', () => {
    const { root, extensionPath } = makeExtLayout();
    expect(resolveChatDistDir(extensionPath)).toBe(path.join(root, 'ui-chat', 'dist'));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('throws a clear error when no candidate has index.html', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-chatview-empty-'));
    expect(() => resolveChatDistDir(path.join(root, 'ext-agent'))).toThrow(/Sunday chat UI not found/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('ChatViewProvider', () => {
  let root: string;
  let extensionPath: string;
  let bridge: ReturnType<typeof makeBridge>;

  beforeEach(() => {
    ({ root, extensionPath } = makeExtLayout());
    bridge = makeBridge();
    return () => fs.rmSync(root, { recursive: true, force: true });
  });

  it('renders webview HTML with webview URIs, nonced scripts, and a strict CSP', () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview } = makeWebview();
    provider.resolveWebviewView(view as any);
    expect(webview.options.enableScripts).toBe(true);
    expect(webview.html).toContain('Content-Security-Policy');
    expect(webview.html).toContain(`script-src 'nonce-`);
    expect(webview.html).not.toContain('./assets/');
    expect(webview.html).toContain('webview://');
    provider.dispose();
  });

  it('posts voice config to the webview on resolve', () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview } = makeWebview();
    provider.resolveWebviewView(view as any);
    const voiceMsg = (webview.postMessage as any).mock.calls
      .map((c: any[]) => c[0])
      .find((m: any) => m?.type === 'sunday/voice/config');
    expect(voiceMsg).toMatchObject({ type: 'sunday/voice/config' });
    expect(typeof voiceMsg.inputEnabled).toBe('boolean');
    expect(typeof voiceMsg.outputEnabled).toBe('boolean');
    expect(voiceMsg.language).toBe('en-US');
    provider.dispose();
  });

  it("shows an info message for 'sunday/voice/unsupported' (graceful fallback, no crash)", async () => {
    const vscode = await import('vscode');
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await handlers[0]({ type: 'sunday/voice/unsupported' });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const msg = (vscode.window.showInformationMessage as any).mock.calls[0][0];
    expect(msg).toContain('not supported');
    provider.dispose();
  });

  it('notifyVoiceConfigChanged re-posts voice config', () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview } = makeWebview();
    provider.resolveWebviewView(view as any);
    (webview.postMessage as any).mockClear();
    provider.notifyVoiceConfigChanged();
    const voiceMsg = (webview.postMessage as any).mock.calls
      .map((c: any[]) => c[0])
      .find((m: any) => m?.type === 'sunday/voice/config');
    expect(voiceMsg).toBeDefined();
    provider.dispose();
  });

  it("routes 'sunday/chat/send' to bridge.chatSend, creating one session", async () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await handlers[0]({ type: 'sunday/chat/send', text: 'hello', model: 'm1' });
    await flush();
    expect(bridge.sessionCreate).toHaveBeenCalledTimes(1);
    expect(bridge.sessionCreate).toHaveBeenCalledWith({ cwd: '/fake/cwd' });
    expect(bridge.chatSend).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      message: [{ type: 'text', text: 'hello' }],
      model: 'm1',
    });
    expect(webview.postMessage).toHaveBeenCalledWith({ type: 'sunday/chat/state', activeTurn: 'turn-1' });
    // Second message reuses the session.
    await handlers[0]({ type: 'sunday/chat/send', text: 'again' });
    await flush();
    expect(bridge.sessionCreate).toHaveBeenCalledTimes(1);
    expect(bridge.chatSend).toHaveBeenCalledTimes(2);
    provider.dispose();
  });

  it('forwards bridge chat events to the webview, with turn-end clearing state', async () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview } = makeWebview();
    provider.resolveWebviewView(view as any);
    const emit = [...bridge.listeners][0];
    emit({ turnId: 'turn-1', sessionId: 'sess-1', event: { type: 'text-delta', delta: 'hi' } });
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'sunday/chat/event',
      turnId: 'turn-1',
      sessionId: 'sess-1',
      event: { type: 'text-delta', delta: 'hi' },
    });
    emit({ turnId: 'turn-1', sessionId: 'sess-1', event: { type: 'turn-end', finishReason: 'stop' } });
    expect(webview.postMessage).toHaveBeenCalledWith({ type: 'sunday/chat/state', activeTurn: null });
    provider.dispose();
  });

  it('passes via/relay through so the webview can badge Relay turns', () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview } = makeWebview();
    provider.resolveWebviewView(view as any);
    const emit = [...bridge.listeners][0];
    emit({
      turnId: 't',
      sessionId: 's',
      event: { type: 'text-delta', delta: 'x' },
      via: 'relay',
      relay: { from: 'openrouter', to: 'groq', reason: '429' },
    });
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'sunday/chat/event',
      turnId: 't',
      sessionId: 's',
      event: { type: 'text-delta', delta: 'x' },
      via: 'relay',
      relay: { from: 'openrouter', to: 'groq', reason: '429' },
    });
    provider.dispose();
  });

  it("routes 'sunday/chat/cancel' to bridge.cancelActiveTurn", async () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await handlers[0]({ type: 'sunday/chat/cancel' });
    await flush();
    expect(bridge.cancelActiveTurn).toHaveBeenCalledTimes(1);
    expect(webview.postMessage).toHaveBeenCalledWith({ type: 'sunday/chat/state', activeTurn: null });
    provider.dispose();
  });

  it("routes 'sunday/models/get' to bridge.modelsList", async () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await handlers[0]({ type: 'sunday/models/get' });
    await flush();
    expect(bridge.modelsList).toHaveBeenCalledTimes(1);
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'sunday/models/list',
      models: [{ id: 'm1', provider: 'groq', label: 'M1' }],
    });
    provider.dispose();
  });

  it('detaches the bridge listener on dispose', () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view } = makeWebview();
    provider.resolveWebviewView(view as any);
    expect(bridge.listeners.size).toBe(1);
    provider.dispose();
    expect(bridge.listeners.size).toBe(0);
  });

  it('notifyBridgeChanged re-subscribes when the bridge instance changes', () => {
    let current = bridge;
    const logs: string[] = [];
    const store = new Map<string, unknown>();
    const provider = new ChatViewProvider({
      extensionPath,
      getBridge: () => asBridge(current),
      ensureBridge: async () => asBridge(current),
      getCwd: () => undefined,
      globalState: {
        get: <T,>(key: string) => store.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
          if (value === undefined) store.delete(key);
          else store.set(key, value);
        },
      },
      log: (m) => logs.push(m),
    });
    const { view } = makeWebview();
    provider.resolveWebviewView(view as any);
    expect(bridge.listeners.size).toBe(1);
    const replacement = makeBridge();
    current = replacement as any;
    provider.notifyBridgeChanged();
    expect(bridge.listeners.size).toBe(0);
    expect(replacement.listeners.size).toBe(1);
    provider.dispose();
    expect(replacement.listeners.size).toBe(0);
  });
});

describe('ChatViewProvider model gating (Task 7)', () => {
  let root: string;
  let extensionPath: string;
  let bridge: ReturnType<typeof makeBridge>;

  const MODELS = [
    { id: 'sunday:flash', provider: 'sunday', label: 'Sunday Flash' },
    { id: 'groq:llama', provider: 'groq', label: 'Groq Llama' },
  ];

  function setView(entitlements: Record<string, boolean | number | string>) {
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
        'browser_agent.enabled': false,
        'browser_agent.daily_sessions': 0,
        'codebase_index.max_repo_mb': 100,
        'autocomplete.managed_route': false,
        'scheduler.priority_class': 'standard',
        'support.tier': 'community',
        ...entitlements,
      },
      cached_at: new Date().toISOString(),
      valid_until: new Date().toISOString(),
    };
    setEntitlementsProvider({
      getEntitlements: async () => ({ view: view as any, source: 'fresh' as const }),
      getCachedSync: () => view as any,
      refresh: async () => ({ view: view as any, source: 'fresh' as const }),
      clear: () => undefined,
    });
  }

  beforeEach(() => {
    ({ root, extensionPath } = makeExtLayout());
    bridge = makeBridge();
    bridge.modelsList = vi.fn(async () => ({ models: MODELS }));
    resetEntitlementsProviderForTests();
    return () => {
      fs.rmSync(root, { recursive: true, force: true });
      resetEntitlementsProviderForTests();
    };
  });

  function lastModelsList(webview: { postMessage: any }) {
    const calls = (webview.postMessage as any).mock.calls.map((c: any[]) => c[0]);
    return calls.filter((m: any) => m?.type === 'sunday/models/list').pop();
  }

  it("excludes managed models from 'sunday/models/list' when the plan denies them", async () => {
    setView({ 'managed_models.enabled': false });
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await handlers[0]({ type: 'sunday/models/get' });
    await flush();
    expect(lastModelsList(webview).models.map((m: any) => m.id)).toEqual(['groq:llama']);
    provider.dispose();
  });

  it("greys managed models with the upgrade hint when the daily limit is reached", async () => {
    setView({ 'managed_models.enabled': true, 'managed_models.daily_requests': 3 });
    const { provider, store } = makeProvider(bridge, extensionPath);
    store.set(usageKeyFor(new Date()), 3);
    const { view, webview, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await handlers[0]({ type: 'sunday/models/get' });
    await flush();
    const models = lastModelsList(webview).models;
    const managed = models.find((m: any) => m.id === 'sunday:flash');
    const byok = models.find((m: any) => m.id === 'groq:llama');
    expect(managed.disabled).toBe(true);
    expect(managed.hint).toContain('Daily limit reached');
    expect(byok.disabled).toBeUndefined();
    provider.dispose();
  });

  it("shows an info message instead of calling the model for a greyed selection", async () => {
    setView({ 'managed_models.enabled': true, 'managed_models.daily_requests': 1 });
    const vscode = await import('vscode');
    const { provider, store } = makeProvider(bridge, extensionPath);
    store.set(usageKeyFor(new Date()), 1);
    const { view, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await handlers[0]({ type: 'sunday/models/get' });
    await flush();
    (vscode.window.showInformationMessage as any).mockClear();
    await handlers[0]({ type: 'sunday/chat/send', text: 'hi', model: 'sunday:flash' });
    await flush();
    expect(bridge.chatSend).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const msg = (vscode.window.showInformationMessage as any).mock.calls[0][0];
    expect(msg).toContain('Daily limit reached');
    provider.dispose();
  });

  it('records managed-model usage after a successful send', async () => {
    setView({ 'managed_models.enabled': true, 'managed_models.daily_requests': 200 });
    const { provider, store } = makeProvider(bridge, extensionPath);
    const { view, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await handlers[0]({ type: 'sunday/models/get' });
    await flush();
    await handlers[0]({ type: 'sunday/chat/send', text: 'hi', model: 'sunday:flash' });
    await flush();
    expect(bridge.chatSend).toHaveBeenCalledTimes(1);
    expect(store.get(usageKeyFor(new Date()))).toBe(1);
    // BYOK models don't touch the counter
    await handlers[0]({ type: 'sunday/chat/send', text: 'again', model: 'groq:llama' });
    await flush();
    expect(store.get(usageKeyFor(new Date()))).toBe(1);
    provider.dispose();
  });

  it('fails open (lists everything) when the entitlements read throws', async () => {
    setEntitlementsProvider({
      getEntitlements: async () => {
        throw new Error('gateway down');
      },
      getCachedSync: () => {
        throw new Error('gateway down');
      },
      refresh: async () => {
        throw new Error('gateway down');
      },
      clear: () => undefined,
    });
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await handlers[0]({ type: 'sunday/models/get' });
    await flush();
    expect(lastModelsList(webview).models.map((m: any) => m.id)).toEqual([
      'sunday:flash',
      'groq:llama',
    ]);
    provider.dispose();
  });
});
