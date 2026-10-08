// Tests for the sunday.orchestration.* commands: registration, the run
// command (goal prompt, parallel flag from config, progress, manager focus),
// and stopAll (confirm dialog, orchestrate/stop). `vscode` is mocked;
// HostBridge is a manual mock. No DOM, no network, no real VS Code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const registered = new Map<string, (...args: any[]) => unknown>();
  return {
    registered,
    window: {
      showInputBox: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      withProgress: vi.fn(async (_opts: any, task: (p: any) => unknown) =>
        task({ report: () => undefined }),
      ),
    },
    commands: {
      registerCommand: vi.fn((id: string, fn: (...args: any[]) => unknown) => {
        registered.set(id, fn);
        return { dispose: () => undefined };
      }),
      executeCommand: vi.fn(async (..._args: any[]) => undefined),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({ get: (_key: string, def: unknown) => def })),
    },
    ProgressLocation: { Notification: 15 },
  };
});

vi.mock('vscode', () => ({
  window: mocks.window,
  commands: mocks.commands,
  workspace: mocks.workspace,
  ProgressLocation: mocks.ProgressLocation,
}));

import {
  ORCHESTRATION_OPEN_MANAGER_COMMAND,
  ORCHESTRATION_RUN_COMMAND,
  ORCHESTRATION_STOP_ALL_COMMAND,
  registerOrchestrationCommands,
  type OrchestrationCommandDeps,
} from './orchestrationCommands.js';
import {
  resetEntitlementsProviderForTests,
  setEntitlementsProvider,
} from './entitlements/provider.js';
import type { HostBridge } from './hostBridge.js';

function makeBridge() {
  return {
    orchestrateRun: vi.fn(async (_p: any) => ({
      units: [
        { id: 'u-a', status: 'merged' },
        { id: 'u-b', status: 'merged' },
      ],
      mergedSha: 'abc123def456',
    })),
    orchestrateStop: vi.fn(async (_runId: string) => ({ stopped: true })),
  };
}
type MockBridge = ReturnType<typeof makeBridge>;

function makeDeps(overrides: Partial<OrchestrationCommandDeps> = {}) {
  const bridge = makeBridge();
  const logs: string[] = [];
  const deps: OrchestrationCommandDeps = {
    getBridge: async () => bridge as unknown as HostBridge,
    getCwd: () => '/fake/cwd',
    getActiveRunId: () => undefined,
    // Mirrors extension.ts: focusing the manager view = executing its focus command.
    openManagerView: vi.fn(() => {
      void mocks.commands.executeCommand('sunday.managerView.focus');
    }),
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { deps, bridge: bridge as unknown as MockBridge, logs };
}

function makeContext(): any {
  return { subscriptions: [] as any[] };
}

const runRegistered = () => mocks.registered.get(ORCHESTRATION_RUN_COMMAND)!;
const stopAllRegistered = () => mocks.registered.get(ORCHESTRATION_STOP_ALL_COMMAND)!;
const openManagerRegistered = () => mocks.registered.get(ORCHESTRATION_OPEN_MANAGER_COMMAND)!;

beforeEach(() => {
  mocks.registered.clear();
  vi.clearAllMocks();
  mocks.workspace.getConfiguration.mockReturnValue({ get: (_key: string, def: unknown) => def });
});

describe('registerOrchestrationCommands', () => {
  it('registers the three sunday.orchestration.* command ids', () => {
    const { deps } = makeDeps();
    registerOrchestrationCommands(makeContext(), deps);
    expect(mocks.registered.has(ORCHESTRATION_RUN_COMMAND)).toBe(true);
    expect(mocks.registered.has(ORCHESTRATION_STOP_ALL_COMMAND)).toBe(true);
    expect(mocks.registered.has(ORCHESTRATION_OPEN_MANAGER_COMMAND)).toBe(true);
    expect(mocks.commands.registerCommand).toHaveBeenCalledTimes(3);
  });

  it('openManager focuses the manager view', async () => {
    const { deps } = makeDeps();
    registerOrchestrationCommands(makeContext(), deps);
    await openManagerRegistered()();
    expect(deps.openManagerView).toHaveBeenCalledTimes(1);
    expect(mocks.commands.executeCommand).toHaveBeenCalledWith('sunday.managerView.focus');
  });
});

describe('sunday.orchestration.run', () => {
  it('prompts for a goal and passes parallel=true from config to orchestrate/run', async () => {
    mocks.window.showInputBox.mockResolvedValueOnce('ship dark mode');
    mocks.workspace.getConfiguration.mockReturnValueOnce({
      get: (key: string, def: unknown) => (key === 'orchestration.parallel' ? true : def),
    });
    const { deps, bridge } = makeDeps();
    registerOrchestrationCommands(makeContext(), deps);
    await runRegistered()();
    expect(mocks.window.showInputBox).toHaveBeenCalledTimes(1);
    expect(bridge.orchestrateRun).toHaveBeenCalledWith({
      goal: 'ship dark mode',
      workspaceRoot: '/fake/cwd',
      parallel: true,
      maxParallel: 3,
    });
    expect(deps.openManagerView).toHaveBeenCalledTimes(1);
    expect(mocks.window.withProgress).toHaveBeenCalledTimes(1);
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('2/2 units merged'),
    );
  });

  it('passes parallel=false when the config is off (ADR-17 default)', async () => {
    mocks.window.showInputBox.mockResolvedValueOnce('goal');
    const { deps, bridge } = makeDeps();
    registerOrchestrationCommands(makeContext(), deps);
    await runRegistered()();
    expect(bridge.orchestrateRun).toHaveBeenCalledWith({
      goal: 'goal',
      workspaceRoot: '/fake/cwd',
      parallel: false,
      maxParallel: 3,
    });
  });

  it('does nothing when the goal prompt is dismissed', async () => {
    mocks.window.showInputBox.mockResolvedValueOnce(undefined);
    const { deps, bridge } = makeDeps();
    registerOrchestrationCommands(makeContext(), deps);
    await runRegistered()();
    expect(bridge.orchestrateRun).not.toHaveBeenCalled();
    expect(deps.openManagerView).not.toHaveBeenCalled();
  });

  it('shows an error when no workspace folder is open', async () => {
    mocks.window.showInputBox.mockResolvedValueOnce('goal');
    const { deps, bridge } = makeDeps({ getCwd: () => undefined });
    registerOrchestrationCommands(makeContext(), deps);
    await runRegistered()();
    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('workspace folder'),
    );
    expect(bridge.orchestrateRun).not.toHaveBeenCalled();
  });

  it('surfaces run failures as an error message', async () => {
    mocks.window.showInputBox.mockResolvedValueOnce('goal');
    const { deps, bridge } = makeDeps();
    bridge.orchestrateRun.mockRejectedValueOnce(new Error('daemon exploded'));
    registerOrchestrationCommands(makeContext(), deps);
    await runRegistered()();
    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('daemon exploded'),
    );
  });
});

describe('sunday.orchestration.stopAll', () => {
  it('informs when there is no active run (no RPC)', async () => {
    const { deps, bridge } = makeDeps({ getActiveRunId: () => undefined });
    registerOrchestrationCommands(makeContext(), deps);
    await stopAllRegistered()();
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('No active Sunday orchestration run'),
    );
    expect(bridge.orchestrateStop).not.toHaveBeenCalled();
  });

  it('confirms, then calls orchestrate/stop with the active runId', async () => {
    mocks.window.showWarningMessage.mockResolvedValueOnce('Stop all');
    const { deps, bridge } = makeDeps({ getActiveRunId: () => 'run-42' });
    registerOrchestrationCommands(makeContext(), deps);
    await stopAllRegistered()();
    expect(mocks.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('run-42'),
      'Stop all',
      'Cancel',
    );
    expect(bridge.orchestrateStop).toHaveBeenCalledWith('run-42');
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      'Sunday orchestration stopped.',
    );
  });

  it('does not stop when the confirm dialog is cancelled', async () => {
    mocks.window.showWarningMessage.mockResolvedValueOnce('Cancel');
    const { deps, bridge } = makeDeps({ getActiveRunId: () => 'run-42' });
    registerOrchestrationCommands(makeContext(), deps);
    await stopAllRegistered()();
    expect(bridge.orchestrateStop).not.toHaveBeenCalled();
  });

  it('reports when the run already finished', async () => {
    mocks.window.showWarningMessage.mockResolvedValueOnce('Stop all');
    const { deps, bridge } = makeDeps({ getActiveRunId: () => 'run-9' });
    bridge.orchestrateStop.mockResolvedValueOnce({ stopped: false });
    registerOrchestrationCommands(makeContext(), deps);
    await stopAllRegistered()();
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      'Sunday orchestration already finished.',
    );
  });
});

describe('sunday.orchestration.run entitlement gates (Task 7)', () => {
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

  function mockConfig(values: Record<string, unknown>) {
    mocks.workspace.getConfiguration.mockReturnValue({
      get: (key: string, def: unknown) => (key in values ? values[key] : def),
    });
  }

  beforeEach(() => {
    resetEntitlementsProviderForTests();
  });

  afterEach(() => {
    resetEntitlementsProviderForTests();
  });

  it('clamps the pool to max_feature_agents and notes the cap', async () => {
    mocks.window.showInputBox.mockResolvedValueOnce('goal');
    mockConfig({ 'orchestration.parallel': true, 'orchestration.maxParallel': 8 });
    setView({ 'orchestration.max_feature_agents': 2, 'orchestration.parallel': true });
    const { deps, bridge } = makeDeps();
    registerOrchestrationCommands(makeContext(), deps);
    await runRegistered()();
    expect(bridge.orchestrateRun).toHaveBeenCalledWith({
      goal: 'goal',
      workspaceRoot: '/fake/cwd',
      parallel: true,
      maxParallel: 2,
      entitlementCaps: { maxFeatureAgents: 2, parallelAllowed: true },
    });
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Capped at 2 agents on your plan'),
    );
  });

  it('forces parallel off when the plan denies it, even when requested', async () => {
    mocks.window.showInputBox.mockResolvedValueOnce('goal');
    mockConfig({ 'orchestration.parallel': true, 'orchestration.maxParallel': 4 });
    setView({ 'orchestration.max_feature_agents': 2, 'orchestration.parallel': false });
    const { deps, bridge } = makeDeps();
    registerOrchestrationCommands(makeContext(), deps);
    await runRegistered()();
    expect(bridge.orchestrateRun).toHaveBeenCalledWith({
      goal: 'goal',
      workspaceRoot: '/fake/cwd',
      parallel: false,
      maxParallel: 2,
      entitlementCaps: { maxFeatureAgents: 2, parallelAllowed: false },
    });
  });

  it('fails open when the entitlements read throws', async () => {
    mocks.window.showInputBox.mockResolvedValueOnce('goal');
    mockConfig({ 'orchestration.parallel': true, 'orchestration.maxParallel': 5 });
    setEntitlementsProvider({
      getEntitlements: async () => {
        throw new Error('gateway down');
      },
      getCachedSync: () => undefined,
      refresh: async () => {
        throw new Error('gateway down');
      },
      clear: () => undefined,
    });
    const { deps, bridge } = makeDeps();
    registerOrchestrationCommands(makeContext(), deps);
    await runRegistered()();
    // No caps forwarded, requested values pass through, no cap note.
    expect(bridge.orchestrateRun).toHaveBeenCalledWith({
      goal: 'goal',
      workspaceRoot: '/fake/cwd',
      parallel: true,
      maxParallel: 5,
    });
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.not.stringContaining('Capped at'),
    );
  });
});
