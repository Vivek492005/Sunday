// Tests for McpViewProvider (Part A): HTML rendering, state snapshot,
// server lifecycle with the workspace-trust prompt, policy approve/revoke,
// and trust-workspace delegation. `vscode` is mocked; HostBridge is manual.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { McpViewProvider, type McpViewDeps } from './mcpView.js';
import type { HostBridge } from './hostBridge.js';

const flush = () => new Promise((r) => setTimeout(r, 20));

type MockBridge = ReturnType<typeof makeBridge>;
const asBridge = (b: MockBridge): HostBridge => b as unknown as HostBridge;

function makeBridge() {
  return {
    mcpServersList: vi.fn(async () => ({
      servers: [
        {
          name: 'ws-tools',
          scope: 'workspace',
          transport: 'stdio',
          state: 'stopped',
          toolCount: 0,
          lastError: undefined,
        },
        {
          name: 'user-tools',
          scope: 'user',
          transport: 'http',
          state: 'running',
          toolCount: 2,
          lastError: undefined,
        },
      ],
      workspaceConfigIgnored: false,
    })),
    mcpServerStart: vi.fn(async (_name: string) => ({ ok: true })),
    mcpServerStop: vi.fn(async (_name: string) => ({ ok: true })),
    mcpServerRestart: vi.fn(async (_name: string) => ({ ok: true })),
    mcpToolsList: vi.fn(async () => ({
      tools: [
        {
          namespaced: 'mcp__user_tools__read',
          server: 'user-tools',
          description: 'read things',
          enabled: true,
        },
      ],
    })),
    mcpCallsHistory: vi.fn(async () => ({ calls: [] })),
    policyApprove: vi.fn(async (tool: string) => ({ approved: [tool], dangerous: [] })),
    policyRevoke: vi.fn(async (tool: string) => ({ approved: [], dangerous: ['mcp__user_tools__read'] })),
    policyList: vi.fn(async () => ({ dangerous: ['mcp__user_tools__read'], approved: [] })),
  };
}

function makeWebview() {
  const handlers: Array<(m: unknown) => void> = [];
  const webview = {
    options: undefined as unknown,
    html: '',
    cspSource: 'https://null',
    postMessage: vi.fn(),
    onDidReceiveMessage: vi.fn((h: (m: unknown) => void) => {
      handlers.push(h);
      return { dispose: () => undefined };
    }),
  };
  const view = { webview, onDidDispose: vi.fn() };
  return { view, webview, handlers };
}

function makeDeps(bridge: MockBridge, overrides: Partial<McpViewDeps> = {}): McpViewDeps {
  return {
    getBridge: () => asBridge(bridge),
    ensureBridge: async () => asBridge(bridge),
    log: () => undefined,
    isWorkspaceTrusted: () => true,
    confirmWorkspaceServerStart: vi.fn(async () => true),
    requestTrustWorkspace: vi.fn(async () => undefined),
    ...overrides,
  };
}

let bridge: MockBridge;
let deps: McpViewDeps;
let provider: McpViewProvider;
let view: ReturnType<typeof makeWebview>;

beforeEach(() => {
  bridge = makeBridge();
  deps = makeDeps(bridge);
  provider = new McpViewProvider(deps);
  view = makeWebview();
  provider.resolveWebviewView(view.view as never);
});

describe('McpViewProvider rendering', () => {
  it('renders a self-contained panel page', async () => {
    await flush();
    expect(view.webview.html).toContain('MCP servers');
    expect(view.webview.html).toContain('Call history');
    expect(view.webview.html).toContain('sunday/mcp/trust-workspace');
  });

  it('posts a state snapshot after resolve', async () => {
    await flush();
    const states = view.webview.postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === 'sunday/mcp/state');
    expect(states).toHaveLength(1);
    expect(states[0].state.servers.map((s: { name: string }) => s.name)).toEqual([
      'ws-tools',
      'user-tools',
    ]);
    expect(states[0].state.dangerous).toEqual(['mcp__user_tools__read']);
    expect(bridge.mcpServersList).toHaveBeenCalled();
    expect(bridge.policyList).toHaveBeenCalled();
  });

  it('posts an error when the bridge is missing', async () => {
    const p2 = new McpViewProvider(makeDeps(bridge, { getBridge: () => undefined }));
    const v2 = makeWebview();
    p2.resolveWebviewView(v2.view as never);
    await flush();
    const errors = v2.webview.postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === 'sunday/mcp/error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/not running/);
  });

  it('serves accessible panel markup: alert banner and focusable controls', async () => {
    await flush();
    const html: string = view.webview.html;
    // The banner region must announce errors/notices to screen readers.
    expect(html).toContain('id="banner" role="alert"');
    // Action buttons are native <button>s with visible text — keyboard
    // operable by construction.
    expect(html).toContain('<button id="refresh">Refresh</button>');
    // Visible keyboard focus indicator (a11y: no outline-less focus).
    expect(html).toContain('button:focus-visible');
  });
});

describe('McpViewProvider messages', () => {
  const send = (msg: unknown) => view.handlers[0](msg);

  it('prompts before starting a workspace server when untrusted; denies cleanly', async () => {
    await flush();
    const untrusted = new McpViewProvider(
      makeDeps(bridge, {
        isWorkspaceTrusted: () => false,
        confirmWorkspaceServerStart: vi.fn(async () => false),
      }),
    );
    const v2 = makeWebview();
    untrusted.resolveWebviewView(v2.view as never);
    await flush();
    v2.handlers[0]({ type: 'sunday/mcp/start', name: 'ws-tools' });
    await flush();
    expect(bridge.mcpServerStart).not.toHaveBeenCalled();
  });

  it('starts a workspace server without a prompt when trusted', async () => {
    await flush();
    send({ type: 'sunday/mcp/start', name: 'ws-tools' });
    await flush();
    expect(bridge.mcpServerStart).toHaveBeenCalledWith('ws-tools');
    expect(deps.confirmWorkspaceServerStart).not.toHaveBeenCalled();
  });

  it('never prompts for user-scope servers even when untrusted', async () => {
    const untrusted = new McpViewProvider(
      makeDeps(bridge, { isWorkspaceTrusted: () => false }),
    );
    const v2 = makeWebview();
    untrusted.resolveWebviewView(v2.view as never);
    await flush();
    v2.handlers[0]({ type: 'sunday/mcp/start', name: 'user-tools' });
    await flush();
    expect(bridge.mcpServerStart).toHaveBeenCalledWith('user-tools');
  });

  it('routes policy approve/revoke and refreshes state', async () => {
    await flush();
    const before = view.webview.postMessage.mock.calls.length;
    send({ type: 'sunday/policy/approve', tool: 'mcp__user_tools__read' });
    await flush();
    expect(bridge.policyApprove).toHaveBeenCalledWith('mcp__user_tools__read');
    expect(view.webview.postMessage.mock.calls.length).toBeGreaterThan(before);
  });

  it('delegates trust-workspace to the extension command', async () => {
    await flush();
    send({ type: 'sunday/mcp/trust-workspace' });
    await flush();
    expect(deps.requestTrustWorkspace).toHaveBeenCalled();
  });

  it('ignores unknown message types without crashing', async () => {
    await flush();
    send({ type: 'sunday/nope' });
    await flush();
    expect(bridge.mcpServerStart).not.toHaveBeenCalled();
  });
});
