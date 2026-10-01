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
  | { type: 'sunday/manager/error'; message: string };

/** Webview → extension. */
export type OutboundMessage =
  | { type: 'sunday/manager/refresh' }
  | { type: 'sunday/manager/stop-turn'; turnId: string }
  | { type: 'sunday/checkpoint/create'; label?: string }
  | { type: 'sunday/checkpoint/restore'; id: string }
  | { type: 'sunday/worktree/add'; branch: string; path?: string }
  | { type: 'sunday/worktree/remove'; path: string; force?: boolean }
  | { type: 'sunday/worktree/merge'; path: string; target?: string };

// -- view state ---------------------------------------------------------------

export interface ManagerState {
  workspaceRoot?: string;
  repoRoot?: string;
  agents: AgentView[];
  checkpoints: CheckpointView[];
  worktrees: WorktreeView[];
  refreshing: boolean;
  /** Last error surfaced by the extension (daemon call failed…). */
  error: string | undefined;
}

export function createInitialState(): ManagerState {
  return {
    agents: [],
    checkpoints: [],
    worktrees: [],
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

/** Shorten a sha for display. */
export function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}
