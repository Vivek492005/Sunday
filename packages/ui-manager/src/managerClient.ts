// Framework-free manager state for the ui-manager webview.
//
// Mirrors the ui-chat chatClient pattern: all state transitions and outbound
// message construction live here (no React, no DOM) so they are unit-testable
// with plain vitest. The React layer (App.tsx) is a thin shell over
// `createInitialState` + the functions below.

// -- wire types (extension↔webview protocol; JSON only) -----------------------

export interface AgentView {
  id: string;
  title: string;
  cwd?: string;
  model?: string;
  updatedAt: string;
  /** Turn currently running in this session, if any. */
  activeTurn?: string;
}

export interface CheckpointView {
  id: string;
  sha: string;
  label: string;
  createdAt: string;
}

export interface WorktreeView {
  path: string;
  branch: string;
  head: string;
}

// -- orchestration (parallel agents) -------------------------------------------

export type UnitRunStatus = 'queued' | 'running' | 'verifying' | 'done' | 'failed' | 'cancelled';
export type RunStatus = 'running' | 'conflicted' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface UnitRunView {
  id: string;
  title: string;
  status: UnitRunStatus;
  worktreePath?: string;
  model?: string;
  steps?: number;
  sha?: string;
  error?: string;
  /** Recent log lines from orchestrate/event details (newest last). */
  log: string[];
}

export interface ConflictHunkView {
  file: string;
  unitA: string;
  unitB: string;
  rangeA: [number, number];
  rangeB: [number, number];
}

export interface MergeConflictView {
  index: number;
  file: string;
  hunks: ConflictHunkView[];
}

export interface OrchestrationRunView {
  runId: string;
  goal: string;
  parallel: boolean;
  status: RunStatus;
  units: UnitRunView[];
  conflicts: MergeConflictView[];
  updatedAt: string;
}

/** Extension → webview. */
export type InboundMessage =
  | {
      type: 'sunday/manager/state';
      workspaceRoot?: string;
      repoRoot?: string;
      agents: AgentView[];
      checkpoints: CheckpointView[];
      worktrees: WorktreeView[];
    }
  | { type: 'sunday/manager/error'; message: string }
  | { type: 'sunday/manager/orchestration'; runs: OrchestrationRunView[] };

/** Webview → extension. */
export type OutboundMessage =
  | { type: 'sunday/manager/refresh' }
  | { type: 'sunday/manager/stop-turn'; turnId: string }
  | { type: 'sunday/checkpoint/create'; label?: string }
  | { type: 'sunday/checkpoint/restore'; id: string }
  | { type: 'sunday/worktree/add'; branch: string; path?: string }
  | { type: 'sunday/worktree/remove'; path: string; force?: boolean }
  | { type: 'sunday/worktree/merge'; path: string; target?: string }
  | { type: 'sunday/orchestration/stopAll' }
  | { type: 'sunday/orchestration/resolve'; runId: string; conflictIndex: number; keepUnitId: string }
  | { type: 'sunday/orchestration/openDiff'; runId: string; conflictIndex: number };

// -- view state ---------------------------------------------------------------

export interface ManagerState {
  workspaceRoot?: string;
  repoRoot?: string;
  agents: AgentView[];
  checkpoints: CheckpointView[];
  worktrees: WorktreeView[];
  orchestration: OrchestrationRunView[];
  refreshing: boolean;
  /** Last error surfaced by the extension (daemon call failed…). */
  error: string | undefined;
}

export function createInitialState(): ManagerState {
  return {
    agents: [],
    checkpoints: [],
    worktrees: [],
    orchestration: [],
    refreshing: true,
    error: undefined,
  };
}

/** Apply a full state snapshot pushed by the extension. Pure. */
export function applyManagerState(
  state: ManagerState,
  snap: Extract<InboundMessage, { type: 'sunday/manager/state' }>,
): ManagerState {
  return {
    ...state,
    workspaceRoot: snap.workspaceRoot,
    repoRoot: snap.repoRoot,
    agents: Array.isArray(snap.agents) ? snap.agents : [],
    checkpoints: Array.isArray(snap.checkpoints) ? snap.checkpoints : [],
    worktrees: Array.isArray(snap.worktrees) ? snap.worktrees : [],
    refreshing: false,
    error: undefined,
  };
}

export function applyManagerError(state: ManagerState, message: string): ManagerState {
  return { ...state, refreshing: false, error: message || 'Manager request failed' };
}

/** Apply an orchestration runs snapshot pushed by the extension. Pure. */
export function applyOrchestrationState(
  state: ManagerState,
  runs: OrchestrationRunView[],
): ManagerState {
  return {
    ...state,
    orchestration: Array.isArray(runs) ? runs : [],
    refreshing: false,
  };
}

/** The latest run that is still actionable (running/conflicted), if any. */
export function activeOrchestrationRun(state: ManagerState): OrchestrationRunView | undefined {
  return state.orchestration.find((r) => r.status === 'running' || r.status === 'conflicted');
}

export function setRefreshing(state: ManagerState, refreshing: boolean): ManagerState {
  return { ...state, refreshing };
}

export function clearError(state: ManagerState): ManagerState {
  return { ...state, error: undefined };
}

// -- outbound actions (take a host so tests can use a mock) --------------------

export interface ManagerHost {
  postMessage(message: OutboundMessage): void;
}

export function requestRefresh(host: ManagerHost): void {
  host.postMessage({ type: 'sunday/manager/refresh' });
}

export function stopTurn(host: ManagerHost, turnId: string): void {
  if (!turnId) return;
  host.postMessage({ type: 'sunday/manager/stop-turn', turnId });
}

export function createCheckpoint(host: ManagerHost, label?: string): void {
  const l = (label ?? '').trim();
  host.postMessage(l ? { type: 'sunday/checkpoint/create', label: l } : { type: 'sunday/checkpoint/create' });
}

export function restoreCheckpoint(host: ManagerHost, id: string): void {
  if (!id) return;
  host.postMessage({ type: 'sunday/checkpoint/restore', id });
}

export function addWorktree(host: ManagerHost, branch: string, path?: string): void {
  const b = branch.trim();
  if (!b) return;
  const p = (path ?? '').trim();
  host.postMessage(p ? { type: 'sunday/worktree/add', branch: b, path: p } : { type: 'sunday/worktree/add', branch: b });
}

export function removeWorktree(host: ManagerHost, wtPath: string, force?: boolean): void {
  if (!wtPath) return;
  host.postMessage({ type: 'sunday/worktree/remove', path: wtPath, force: force ?? false });
}

export function mergeWorktree(host: ManagerHost, wtPath: string, target?: string): void {
  if (!wtPath) return;
  const t = (target ?? '').trim();
  host.postMessage(
    t ? { type: 'sunday/worktree/merge', path: wtPath, target: t } : { type: 'sunday/worktree/merge', path: wtPath },
  );
}

/** Stop all units of the active orchestration run (extension confirms first). */
export function stopAllOrchestration(host: ManagerHost): void {
  host.postMessage({ type: 'sunday/orchestration/stopAll' });
}

/** Resolve one merge conflict in favour of a unit's version. */
export function resolveConflict(
  host: ManagerHost,
  runId: string,
  conflictIndex: number,
  keepUnitId: string,
): void {
  if (!runId || !keepUnitId || !Number.isInteger(conflictIndex) || conflictIndex < 0) return;
  host.postMessage({ type: 'sunday/orchestration/resolve', runId, conflictIndex, keepUnitId });
}

/** Open a vscode.diff between the two worktree files of a conflict. */
export function openConflictDiff(host: ManagerHost, runId: string, conflictIndex: number): void {
  if (!runId || !Number.isInteger(conflictIndex) || conflictIndex < 0) return;
  host.postMessage({ type: 'sunday/orchestration/openDiff', runId, conflictIndex });
}

/** Shorten a sha for display. */
export function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}
