// Tests for the ManagerViewProvider orchestration section (parallel agents
// phase): orchestrate/event → live run views, per-conflict resolve buttons
// calling orchestrate/resolveConflict with { conflictIndex, keepUnitId },
// "Open diff" (vscode.diff between the two worktree files), the webview
// "Stop all" button, and transition notifications. `vscode` is mocked;
// HostBridge is a manual mock. Mirrors managerView.test.ts patterns.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(async () => undefined),
  },
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => p, scheme: 'file' }),
  },
  window: mocks.window,
  commands: mocks.commands,
}));

import { ManagerViewProvider } from './managerView.js';
import type { HostBridge } from './hostBridge.js';
import type { OrchestrationRunState } from '@sunday/protocol';

const flush = () => new Promise((r) => setTimeout(r, 20));

const RUN_STATE: OrchestrationRunState = {
  runId: 'run-1',
  goal: 'ship dark mode',
  parallel: true,
  status: 'running',
  units: [
    {
      id: 'u-a',
      title: 'Toggle component',
      status: 'verifying',
      worktreePath: '/wt/u-a',
      model: 'groq:llama-3.1-8b-instant',
      steps: 12,
    },
    { id: 'u-b', title: 'Settings wiring', status: 'queued', worktreePath: '/wt/u-b' },
  ],
  conflicts: [],
  createdAt: '2026-10-01T20:00:00Z',
  updatedAt: '2026-10-01T20:05:00Z',
};

const CONFLICTED_STATE: OrchestrationRunState = {
  ...RUN_STATE,
  status: 'conflicted',
  units: [
    { ...RUN_STATE.units[0], status: 'done' },
    { ...RUN_STATE.units[1], status: 'done' },
  ],
  conflicts: [
    {
      index: 0,
      file: 'src/settings.ts',
      hunks: [
        {
          file: 'src/settings.ts',
          unitA: 'u-a',
          unitB: 'u-b',
          rangeA: [12, 34],
          rangeB: [10, 30],
        },
      ],
    },
  ],
};

function makeBridge() {
  const chatListeners = new Set<(n: any) => void>();
  const orchestrateListeners = new Set<(n: any) => void>();
  return {
    chatListeners,
    orchestrateListeners,
    sessionList: vi.fn(async () => ({ sessions: [] })),
    checkpointList: vi.fn(async () => ({ checkpoints: [] })),
    worktreeList: vi.fn(async () => ({ worktrees: [] })),
    chatCancel: vi.fn(async () => ({ ok: true })),
    onChatEvent: vi.fn((l: (n: any) => void) => {
      chatListeners.add(l);
      return () => {
        chatListeners.delete(l);
      };
    }),
    onOrchestrateEvent: vi.fn((l: (n: any) => void) => {
      orchestrateListeners.add(l);
      return () => {
        orchestrateListeners.delete(l);
      };
    }),
    orchestrateStatus: vi.fn(async (_runId: string) => structuredClone(RUN_STATE)),
    orchestrateStop: vi.fn(async (_runId: string) => ({ stopped: true })),
    orchestrateResolveConflict: vi.fn(async (_runId: string, _res: unknown[]) => ({
      conflicts: [],
      merged: ['u-a'],
    })),
  };
}
type MockBridge = ReturnType<typeof makeBridge>;
const asBridge = (b: MockBridge): HostBridge => b as unknown as HostBridge;

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

function makeExtLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-mgr-orch-'));
  const extensionPath = path.join(root, 'ext-agent');
  const distDir = path.join(root, 'ui-manager', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  return { root, extensionPath };
}

function makeProvider(bridge: MockBridge, extensionPath: string) {
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

function lastOrchestrationMessage(webview: { postMessage: ReturnType<typeof vi.fn> }) {
  const calls = webview.postMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m && m.type === 'sunday/manager/orchestration');
  return calls[calls.length - 1];
}

const emitOrchestrate = (bridge: MockBridge, event: unknown) => {
  for (const l of [...bridge.orchestrateListeners]) l(event);
};

describe('ManagerViewProvider orchestration', () => {
  let root: string;
  let extensionPath: string;
  let bridge: MockBridge;

  beforeEach(() => {
    ({ root, extensionPath } = makeExtLayout());
    bridge = makeBridge();
    vi.clearAllMocks();
    return () => fs.rmSync(root, { recursive: true, force: true });
  });

  it('subscribes to orchestrate/event and posts run views with per-unit cards', async () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    expect(bridge.onOrchestrateEvent).toHaveBeenCalledTimes(1);

    emitOrchestrate(bridge, {
      runId: 'run-1',
      unitId: 'u-a',
      phase: 'verifying',
      detail: 'running tests…\n12 passed',
    });
    await flush();

    expect(bridge.orchestrateStatus).toHaveBeenCalledWith('run-1');
    const msg = lastOrchestrationMessage(webview);
    expect(msg.runs).toHaveLength(1);
    const run = msg.runs[0];
    expect(run.runId).toBe('run-1');
    expect(run.goal).toBe('ship dark mode');
    expect(run.parallel).toBe(true);
    const unitA = run.units.find((u: any) => u.id === 'u-a');
    expect(unitA.status).toBe('verifying');
    expect(unitA.worktreePath).toBe('/wt/u-a');
    expect(unitA.model).toBe('groq:llama-3.1-8b-instant');
    expect(unitA.steps).toBe(12);
    // Log lines come from the event detail.
    expect(unitA.log).toEqual(['running tests…', '12 passed']);
    provider.dispose();
  });

  it('fires an information message when a unit fails', async () => {
    bridge.orchestrateStatus
      .mockResolvedValueOnce(structuredClone(RUN_STATE))
      .mockResolvedValueOnce({
        ...structuredClone(RUN_STATE),
        units: [
          { ...RUN_STATE.units[0], status: 'verifying' as const },
          { ...RUN_STATE.units[1], status: 'failed' as const, error: 'tests red' },
        ],
      });
    const { provider } = makeProvider(bridge, extensionPath);
    const { view } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    emitOrchestrate(bridge, { runId: 'run-1', unitId: 'u-b', phase: 'started' });
    await flush();
    emitOrchestrate(bridge, { runId: 'run-1', unitId: 'u-b', phase: 'failed', detail: 'tests red' });
    await flush();
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('unit "Settings wiring" failed'),
    );
    provider.dispose();
  });

  it('fires an information message when the run becomes conflicted', async () => {
    bridge.orchestrateStatus
      .mockResolvedValueOnce(structuredClone(RUN_STATE))
      .mockResolvedValueOnce(structuredClone(CONFLICTED_STATE));
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    emitOrchestrate(bridge, { runId: 'run-1', unitId: 'u-a', phase: 'started' });
    await flush();
    emitOrchestrate(bridge, { runId: 'run-1', unitId: '', phase: 'conflicted', detail: '[]' });
    await flush();
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('merge conflicts'),
    );
    const run = lastOrchestrationMessage(webview).runs[0];
    expect(run.status).toBe('conflicted');
    expect(run.conflicts).toHaveLength(1);
    expect(run.conflicts[0].file).toBe('src/settings.ts');
    provider.dispose();
  });

  it('getActiveRunId tracks running/conflicted runs', async () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    expect(provider.getActiveRunId()).toBeUndefined();
    emitOrchestrate(bridge, { runId: 'run-1', unitId: 'u-a', phase: 'started' });
    await flush();
    expect(provider.getActiveRunId()).toBe('run-1');
    provider.dispose();
  });

  it("routes 'sunday/orchestration/resolve' to orchestrate/resolveConflict with { conflictIndex, keepUnitId }", async () => {
    bridge.orchestrateStatus.mockResolvedValue(structuredClone(CONFLICTED_STATE));
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, webview, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    // Seed the run view so refresh-after-resolve has a before-state.
    emitOrchestrate(bridge, { runId: 'run-1', unitId: '', phase: 'conflicted', detail: '[]' });
    await flush();

    await handlers[0]({
      type: 'sunday/orchestration/resolve',
      runId: 'run-1',
      conflictIndex: 0,
      keepUnitId: 'u-a',
    });
    await flush();

    expect(bridge.orchestrateResolveConflict).toHaveBeenCalledWith('run-1', [
      { conflictIndex: 0, keepUnitId: 'u-a' },
    ]);
    // After resolution the run is refreshed from orchestrate/status.
    expect(bridge.orchestrateStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(lastOrchestrationMessage(webview).runs[0].runId).toBe('run-1');
    provider.dispose();
  });

  it("routes 'sunday/orchestration/stopAll' to orchestrate/stop for the active run", async () => {
    mocks.window.showWarningMessage.mockResolvedValueOnce('Stop all');
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    emitOrchestrate(bridge, { runId: 'run-1', unitId: 'u-a', phase: 'started' });
    await flush();

    await handlers[0]({ type: 'sunday/orchestration/stopAll' });
    await flush();

    expect(mocks.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('run-1'),
      'Stop all',
      'Cancel',
    );
    expect(bridge.orchestrateStop).toHaveBeenCalledWith('run-1');
    provider.dispose();
  });

  it("routes 'sunday/orchestration/openDiff' to vscode.diff between the two worktree files", async () => {
    bridge.orchestrateStatus.mockResolvedValue(structuredClone(CONFLICTED_STATE));
    const { provider } = makeProvider(bridge, extensionPath);
    const { view, handlers } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();
    emitOrchestrate(bridge, { runId: 'run-1', unitId: '', phase: 'conflicted', detail: '[]' });
    await flush();

    await handlers[0]({ type: 'sunday/orchestration/openDiff', runId: 'run-1', conflictIndex: 0 });
    await flush();

    expect(mocks.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ fsPath: path.join('/wt/u-a', 'src/settings.ts') }),
      expect.objectContaining({ fsPath: path.join('/wt/u-b', 'src', 'settings.ts') }),
      expect.stringContaining('u-a'),
    );
    provider.dispose();
  });

  it('falls back to event projection when orchestrate/status is unavailable', async () => {
    bridge.orchestrateStatus.mockRejectedValue(new Error('unknown method'));
    const { provider, logs } = makeProvider(bridge, extensionPath);
    const { view, webview } = makeWebview();
    provider.resolveWebviewView(view as any);
    await flush();

    emitOrchestrate(bridge, { runId: 'run-1', unitId: 'u-a', phase: 'started', detail: 'delegating…' });
    await flush();
    emitOrchestrate(bridge, { runId: 'run-1', unitId: 'u-a', phase: 'failed', detail: 'boom' });
    await flush();

    const run = lastOrchestrationMessage(webview).runs[0];
    expect(run.runId).toBe('run-1');
    const unitA = run.units.find((u: any) => u.id === 'u-a');
    expect(unitA.status).toBe('failed');
    expect(unitA.log).toEqual(['delegating…', 'boom']);
    expect(logs.some((l) => l.includes('orchestrate/status failed'))).toBe(true);
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('unit "u-a" failed'),
    );
    provider.dispose();
  });

  it('detaches the orchestrate listener on dispose', () => {
    const { provider } = makeProvider(bridge, extensionPath);
    const { view } = makeWebview();
    provider.resolveWebviewView(view as any);
    expect(bridge.orchestrateListeners.size).toBe(1);
    provider.dispose();
    expect(bridge.orchestrateListeners.size).toBe(0);
  });
});
