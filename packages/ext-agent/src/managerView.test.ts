// Tests for the Agent Manager webview hosts: ManagerViewProvider (sidebar
// WebviewView) and ManagerPanelManager (P-030 Stage 1 editor-area
// WebviewPanel). Both share HTML serving + message routing via
// ManagerWebviewController: webview message routing to the manager RPC
// surface (sessions, chat/cancel, checkpoint/*, worktree/*), state
// snapshots, per-session turn tracking, and disposal. `vscode` is mocked;
// HostBridge is a manual mock. No DOM, no network, no real VS Code.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockCreateWebviewPanel } = vi.hoisted(() => ({
  mockCreateWebviewPanel: vi.fn(),
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => p, scheme: 'file' }),
  },
  ViewColumn: { One: 1, Beside: 2 },
  window: {
    createWebviewPanel: mockCreateWebviewPanel,
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
  },
}));

import {
  ManagerViewProvider,
  ManagerPanelManager,
  MANAGER_PANEL_TYPE,
  resolveManagerDistDir,
} from './managerView.js';
import type { HostBridge } from './hostBridge.js';

type MockBridge = ReturnType<typeof makeBridge>;
const asBridge = (b: MockBridge): HostBridge => b as unknown as HostBridge;

const flush = () => new Promise((r) => setTimeout(r, 20));

function makeBridge() {
  const listeners = new Set<(n: any) => void>();
  const orchestrateListeners = new Set<(n: any) => void>();
  return {
    listeners,
    orchestrateListeners,
    sessionList: vi.fn(async () => ({
      sessions: [{ id: 'sess-1', title: 'T1', cwd: '/fake/cwd', updatedAt: '2026-10-01T00:00:00Z' }],
    })),
    chatCancel: vi.fn(async (_p: any) => ({ ok: true })),
    checkpointCreate: vi.fn(async (_p: any) => ({ id: 'c1', sha: 'sha1', createdAt: '2026-10-01T00:00:00Z' })),
    checkpointList: vi.fn(async (_p: any) => ({
      checkpoints: [{ id: 'c1', sha: 'sha1', label: 'L', createdAt: '2026-10-01T00:00:00Z' }],
    })),
    checkpointRestore: vi.fn(async (_p: any) => ({ id: 'c1', sha: 'sha1', filesRestored: 3 })),
    worktreeAdd: vi.fn(async (p: any) => ({ path: p.path ?? '/wt/new', branch: p.branch })),
    worktreeList: vi.fn(async (_p: any) => ({
      worktrees: [{ path: '/wt/a', branch: 'feat', head: 'head1' }],
    })),
    worktreeRemove: vi.fn(async (_p: any) => ({ removed: true })),
    worktreeMerge: vi.fn(async (p: any) => ({ merged: true, sha: 'msha', target: 'main' })),
    onChatEvent: vi.fn((l: (n: any) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
    onOrchestrateEvent: vi.fn((l: (n: any) => void) => {
      orchestrateListeners.add(l);
      return () => {
        orchestrateListeners.delete(l);
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

/** Fake extension layout: <tmp>/ext-agent + <tmp>/ui-manager/dist/index.html. */
function makeExtLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-managerview-'));
  const extensionPath = path.join(root, 'ext-agent');
  const distDir = path.join(root, 'ui-manager', 'dist');
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
  const provider = new ManagerViewProvider({
    extensionPath,
    getBridge: () => asBridge(bridge),
    ensureBridge: async () => asBridge(bridge),
    getCwd: () => '/fake/cwd',
    log: (m) => logs.push(m),
  });
  return { provider, logs };
}

function lastStateMessage(webview: { postMessage: ReturnType<typeof vi.fn> }) {
  const calls = webview.postMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m && m.type === 'sunday/manager/state');
  return calls[calls.length - 1];
}

describe('resolveManagerDistDir', () => {
  it('prefers the dev-checkout candidate containing index.html', () => {
    const { root, extensionPath } = makeExtLayout();
    expect(resolveManagerDistDir(extensionPath)).toBe(path.join(root, 'ui-manager', 'dist'));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('throws a clear error when no candidate has index.html', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-managerview-empty-'));
    expect(() => resolveManagerDistDir(path.join(root, 'ext-agent'))).toThrow(/Sunday manager UI not found/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('ManagerViewProvider', () => {
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

  it('pushes an initial state snapshot on resolve', async () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    expect(bridge.sessionList).toHaveBeenCalledTimes(1);
    expect(bridge.checkpointList).toHaveBeenCalledWith({ workspaceRoot: '/fake/cwd' });
    expect(bridge.worktreeList).toHaveBeenCalledWith({ repoRoot: '/fake/cwd' });
    const state = lastStateMessage(webview);
    expect(state.workspaceRoot).toBe('/fake/cwd');
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].activeTurn).toBeUndefined();
    expect(state.checkpoints).toHaveLength(1);
    expect(state.worktrees).toHaveLength(1);
    provider.dispose();
  });

  it('tracks per-session active turns from chat events', async () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    const emit = [...bridge.listeners][0];
    emit({ turnId: 'turn-7', sessionId: 'sess-1', event: { type: 'text-delta', delta: 'hi' } });
    await handlers[0]({ type: 'sunday/manager/refresh' });
    await flush();
    expect(lastStateMessage(webview).agents[0].activeTurn).toBe('turn-7');
    emit({ turnId: 'turn-7', sessionId: 'sess-1', event: { type: 'turn-end', finishReason: 'stop' } });
    await handlers[0]({ type: 'sunday/manager/refresh' });
    await flush();
    expect(lastStateMessage(webview).agents[0].activeTurn).toBeUndefined();
    provider.dispose();
  });

  it("routes 'sunday/manager/stop-turn' to bridge.chatCancel", async () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    await handlers[0]({ type: 'sunday/manager/stop-turn', turnId: 'turn-7' });
    await flush();
    expect(bridge.chatCancel).toHaveBeenCalledWith('turn-7');
    provider.dispose();
  });

  it("routes 'sunday/checkpoint/create' and 'sunday/checkpoint/restore'", async () => {
    const { provider, logs } = makeProvider(bridge, extensionPath);
    const { view, webview, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    await handlers[0]({ type: 'sunday/checkpoint/create', label: 'pre' });
    await flush();
    expect(bridge.checkpointCreate).toHaveBeenCalledWith({ workspaceRoot: '/fake/cwd', label: 'pre' });
    expect(logs.some((l) => l.includes('checkpoint created sha1'))).toBe(true);
    await handlers[0]({ type: 'sunday/checkpoint/restore', id: 'c1' });
    await flush();
    expect(bridge.checkpointRestore).toHaveBeenCalledWith({ workspaceRoot: '/fake/cwd', id: 'c1' });
    // Each mutation re-pushes state.
    expect(
      webview.postMessage.mock.calls.filter((c) => c[0]?.type === 'sunday/manager/state').length,
    ).toBeGreaterThanOrEqual(3);
    provider.dispose();
  });

  it("routes 'sunday/worktree/add', 'remove', and 'merge'", async () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    await handlers[0]({ type: 'sunday/worktree/add', branch: 'feature/n' });
    await flush();
    expect(bridge.worktreeAdd).toHaveBeenCalledWith({ repoRoot: '/fake/cwd', branch: 'feature/n' });
    await handlers[0]({ type: 'sunday/worktree/remove', path: '/wt/a', force: false });
    await flush();
    expect(bridge.worktreeRemove).toHaveBeenCalledWith({ repoRoot: '/fake/cwd', path: '/wt/a', force: false });
    await handlers[0]({ type: 'sunday/worktree/merge', path: '/wt/a' });
    await flush();
    expect(bridge.worktreeMerge).toHaveBeenCalledWith({ repoRoot: '/fake/cwd', path: '/wt/a' });
    provider.dispose();
  });

  it('posts sunday/manager/error when a daemon call fails', async () => {
    bridge.checkpointCreate.mockRejectedValueOnce(new Error('git exploded'));
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    await handlers[0]({ type: 'sunday/checkpoint/create' });
    await flush();
    const errors = webview.postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m && m.type === 'sunday/manager/error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[errors.length - 1].message).toContain('git exploded');
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
    const provider = new ManagerViewProvider({
      extensionPath,
      getBridge: () => asBridge(current),
      ensureBridge: async () => asBridge(current),
      getCwd: () => undefined,
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

/** Fake WebviewPanel: webview + reveal/dispose + onDidDispose. */
function makePanel() {
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
  const disposeHandlers: Array<() => void> = [];
  const panel = {
    webview,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn((h: () => void) => {
      disposeHandlers.push(h);
      return { dispose: () => undefined };
    }),
  };
  return { panel, webview, handlers, disposeHandlers };
}

function makePanelManager(bridge: ReturnType<typeof makeBridge>, extensionPath: string) {
  const logs: string[] = [];
  const manager = new ManagerPanelManager({
    extensionPath,
    getBridge: () => asBridge(bridge),
    ensureBridge: async () => asBridge(bridge),
    getCwd: () => '/fake/cwd',
    log: (m) => logs.push(m),
  });
  return { manager, logs };
}

describe('ManagerPanelManager', () => {
  let root: string;
  let extensionPath: string;
  let bridge: ReturnType<typeof makeBridge>;

  beforeEach(() => {
    ({ root, extensionPath } = makeExtLayout());
    bridge = makeBridge();
    mockCreateWebviewPanel.mockReset();
    return () => fs.rmSync(root, { recursive: true, force: true });
  });

  it('reveal() creates a webview panel with the manager type, title, and column', () => {
    const { manager } = makePanelManager(bridge, extensionPath);
    const { panel } = makePanel();
    mockCreateWebviewPanel.mockReturnValue(panel);
    manager.reveal();
    expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);
    const [viewType, title, column, options] = mockCreateWebviewPanel.mock.calls[0];
    expect(viewType).toBe(MANAGER_PANEL_TYPE);
    expect(viewType).toBe('sunday.managerPanel');
    expect(title).toBe('Sunday Manager');
    expect(column).toBe(1); // ViewColumn.One
    expect(options.enableScripts).toBe(true);
    expect(options.retainContextWhenHidden).toBe(true);
    manager.dispose();
  });

  it('reveal() reuses the existing panel instead of creating a new one', () => {
    const { manager } = makePanelManager(bridge, extensionPath);
    const { panel } = makePanel();
    mockCreateWebviewPanel.mockReturnValue(panel);
    manager.reveal();
    manager.reveal();
    expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledWith(1); // ViewColumn.One
    manager.dispose();
  });

  it('serves the same HTML (webview URIs, nonced scripts, strict CSP) as the sidebar view', () => {
    const { manager } = makePanelManager(bridge, extensionPath);
    const { panel, webview } = makePanel();
    mockCreateWebviewPanel.mockReturnValue(panel);
    manager.reveal();
    expect(webview.options.enableScripts).toBe(true);
    expect(webview.html).toContain('Content-Security-Policy');
    expect(webview.html).toContain(`script-src 'nonce-`);
    expect(webview.html).not.toContain('./assets/');
    expect(webview.html).toContain('webview://');
    manager.dispose();
  });

  it('pushes an initial state snapshot and routes messages like the sidebar view', async () => {
    const { manager } = makePanelManager(bridge, extensionPath);
    const { panel, webview, handlers } = makePanel();
    mockCreateWebviewPanel.mockReturnValue(panel);
    manager.reveal();
    await flush();
    expect(bridge.sessionList).toHaveBeenCalledTimes(1);
    const state = lastStateMessage(webview);
    expect(state.workspaceRoot).toBe('/fake/cwd');
    expect(state.agents).toHaveLength(1);
    await handlers[0]({ type: 'sunday/manager/stop-turn', turnId: 'turn-7' });
    await flush();
    expect(bridge.chatCancel).toHaveBeenCalledWith('turn-7');
    manager.dispose();
  });

  it('creates a fresh panel after the old one is disposed', () => {
    const { manager } = makePanelManager(bridge, extensionPath);
    const first = makePanel();
    const second = makePanel();
    mockCreateWebviewPanel.mockReturnValueOnce(first.panel).mockReturnValueOnce(second.panel);
    manager.reveal();
    expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);
    // Simulate the user closing the panel.
    first.disposeHandlers.forEach((h) => h());
    manager.reveal();
    expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(2);
    expect(second.panel.reveal).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('detaches the bridge listener on dispose', () => {
    const { manager } = makePanelManager(bridge, extensionPath);
    const { panel } = makePanel();
    mockCreateWebviewPanel.mockReturnValue(panel);
    manager.reveal();
    expect(bridge.listeners.size).toBe(1);
    manager.dispose();
    expect(bridge.listeners.size).toBe(0);
  });

  it('notifyBridgeChanged re-subscribes when the bridge instance changes', () => {
    let current = bridge;
    const { panel } = makePanel();
    mockCreateWebviewPanel.mockReturnValue(panel);
    const manager = new ManagerPanelManager({
      extensionPath,
      getBridge: () => asBridge(current),
      ensureBridge: async () => asBridge(current),
      getCwd: () => undefined,
      log: () => undefined,
    });
    manager.reveal();
    expect(bridge.listeners.size).toBe(1);
    const replacement = makeBridge();
    current = replacement as any;
    manager.notifyBridgeChanged();
    expect(bridge.listeners.size).toBe(0);
    expect(replacement.listeners.size).toBe(1);
    manager.dispose();
    expect(replacement.listeners.size).toBe(0);
  });
});
