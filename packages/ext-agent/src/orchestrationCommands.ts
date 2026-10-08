// sunday-agent — orchestration commands (parallel agents phase).
//
// Command implementations behind sunday.orchestration.*: run (prompt for a
// goal, pass the sunday.orchestration.parallel config flag to
// orchestrate/run, show progress, open the manager view), stopAll (confirm,
// then orchestrate/stop the active run), openManager (focus the manager
// view). vscode-coupled by design; covered by orchestrationCommands.test.ts
// with a mocked `vscode` module.
import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';
import { getEntitlementsView } from './entitlements/provider.js';
import {
  DEFAULT_MAX_PARALLEL,
  resolveOrchestrationCaps,
} from './entitlements/orchestrationGating.js';

export const ORCHESTRATION_RUN_COMMAND = 'sunday.orchestration.run';
export const ORCHESTRATION_STOP_ALL_COMMAND = 'sunday.orchestration.stopAll';
export const ORCHESTRATION_OPEN_MANAGER_COMMAND = 'sunday.orchestration.openManager';

/** Config key for the parallel-agents default (ADR-17: sequential default). */
export const ORCHESTRATION_PARALLEL_CONFIG_KEY = 'orchestration.parallel';
/** Config key for the requested parallel pool size (clamped by the plan's agent limit). */
export const ORCHESTRATION_MAX_PARALLEL_CONFIG_KEY = 'orchestration.maxParallel';

/** View id of the Sunday Manager webview (mirrors ManagerViewProvider). */
export const MANAGER_VIEW_FOCUS_COMMAND = 'sunday.managerView.focus';

export interface OrchestrationCommandDeps {
  /**
   * Bridge, or undefined when the sidecar is not running. Implementations
   * are expected to have surfaced that to the user already (as
   * getBridgeForCommands in extension.ts does).
   */
  getBridge: () => Promise<HostBridge | undefined>;
  /** First workspace folder, if any. */
  getCwd: () => string | undefined;
  /** Run id currently tracked as active (via orchestrate/event), if any. */
  getActiveRunId: () => string | undefined;
  /** Focus the Sunday Manager view. */
  openManagerView: () => void;
  log: (msg: string) => void;
}

export function registerOrchestrationCommands(
  context: vscode.ExtensionContext,
  deps: OrchestrationCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(ORCHESTRATION_RUN_COMMAND, () => runOrchestration(deps)),
    vscode.commands.registerCommand(ORCHESTRATION_STOP_ALL_COMMAND, () => stopAllOrchestration(deps)),
    vscode.commands.registerCommand(ORCHESTRATION_OPEN_MANAGER_COMMAND, () => deps.openManagerView()),
  );
}

function readParallelConfig(): boolean {
  return vscode.workspace.getConfiguration('sunday').get<boolean>(ORCHESTRATION_PARALLEL_CONFIG_KEY, false);
}

function readMaxParallelConfig(): number {
  const v = vscode.workspace
    .getConfiguration('sunday')
    .get<number>(ORCHESTRATION_MAX_PARALLEL_CONFIG_KEY, DEFAULT_MAX_PARALLEL);
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_MAX_PARALLEL;
}

export async function runOrchestration(deps: OrchestrationCommandDeps): Promise<void> {
  const goal = await vscode.window.showInputBox({
    title: 'Sunday: Run orchestration',
    prompt: 'Goal for the agent run (decomposed into units, each in its own worktree)',
    placeHolder: 'e.g. Add a dark-mode toggle to the settings page',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a goal.'),
  });
  if (!goal) return; // dismissed — no-op
  const workspaceRoot = deps.getCwd();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Sunday orchestration needs an open workspace folder.');
    return;
  }
  const bridge = await deps.getBridge();
  if (!bridge) return;
  // Task 7 gate: clamp the parallel pool to the plan's agent limit and
  // force sequential mode when the plan denies parallel — even when the
  // plan's paths don't overlap. Fail open on any entitlement problem.
  const requestedParallel = readParallelConfig();
  const requestedMaxParallel = readMaxParallelConfig();
  const caps = resolveOrchestrationCaps({
    requestedParallel,
    requestedMaxParallel,
    view: await getEntitlementsView(deps.log),
  });
  deps.log(
    `orchestration: run requested (parallel=${caps.parallel}, maxParallel=${caps.maxParallel}` +
      `${caps.capped ? `, ${caps.capNote}` : ''}) for goal "${goal.trim().slice(0, 80)}"`,
  );
  deps.openManagerView();
  try {
    const res = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Sunday: running orchestration…',
        cancellable: false,
      },
      () =>
        bridge.orchestrateRun({
          goal: goal.trim(),
          workspaceRoot,
          parallel: caps.parallel,
          maxParallel: caps.maxParallel,
          // Forwarded so the daemon re-enforces the caps server-side
          // (omitted when entitlements are unknown — the runner fails open).
          ...(caps.entitlementCaps ? { entitlementCaps: caps.entitlementCaps } : {}),
        }),
    );
    const merged = res.units.filter((u) => u.status === 'merged').length;
    vscode.window.showInformationMessage(
      `Sunday orchestration finished: ${merged}/${res.units.length} units merged` +
        (res.mergedSha ? ` (${res.mergedSha.slice(0, 12)}).` : '.') +
        (caps.capNote ? ` ${caps.capNote}.` : ''),
    );
  } catch (err) {
    deps.log(`orchestration: run failed: ${(err as Error).message}`);
    vscode.window.showErrorMessage(`Sunday orchestration failed: ${(err as Error).message}`);
  }
}

export async function stopAllOrchestration(deps: OrchestrationCommandDeps): Promise<void> {
  const runId = deps.getActiveRunId();
  if (!runId) {
    vscode.window.showInformationMessage('No active Sunday orchestration run.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Stop all units of orchestration run "${runId}"?`,
    'Stop all',
    'Cancel',
  );
  if (choice !== 'Stop all') return;
  const bridge = await deps.getBridge();
  if (!bridge) return;
  try {
    const { stopped } = await bridge.orchestrateStop(runId);
    deps.log(`orchestration: stopAll ${runId} → stopped=${stopped}`);
    vscode.window.showInformationMessage(
      stopped ? 'Sunday orchestration stopped.' : 'Sunday orchestration already finished.',
    );
  } catch (err) {
    deps.log(`orchestration: stopAll failed: ${(err as Error).message}`);
    vscode.window.showErrorMessage(`Sunday orchestration stop failed: ${(err as Error).message}`);
  }
}
