import { parseParams, type ManagerMethodName } from '@sunday/protocol';
import type { SundayDaemon } from './daemon.js';
import { CheckpointManager } from './checkpoints.js';
import { WorktreeManager } from './worktrees.js';

// sundayd — Phase 4 manager methods (checkpoints + worktrees).
//
// Handlers validate params against the MANAGER_METHODS zod schemas (via
// parseParams) and return plain objects matching the result schemas — the
// same contract the @sunday/context handlers follow. Wiring is a single
// exported `registerManagerMethods(daemon)` so cli.ts (owned by the parent)
// stays the only place that touches daemon construction.

export type ManagerHandler = (params: unknown) => Promise<unknown>;

/** Build the method → handler table. Managers are per-table instances so
 *  tests can construct isolated copies. */
export function createManagerHandlers(
  checkpoints = new CheckpointManager(),
  worktrees = new WorktreeManager(),
): Record<ManagerMethodName, ManagerHandler> {
  return {
    'checkpoint/create': async (params) => checkpoints.create(parseParams('checkpoint/create', params)),
    'checkpoint/list': async (params) => checkpoints.list(parseParams('checkpoint/list', params).workspaceRoot),
    'checkpoint/restore': async (params) => checkpoints.restore(parseParams('checkpoint/restore', params)),
    'worktree/add': async (params) => worktrees.add(parseParams('worktree/add', params)),
    'worktree/list': async (params) => worktrees.list(parseParams('worktree/list', params).repoRoot),
    'worktree/remove': async (params) => worktrees.remove(parseParams('worktree/remove', params)),
    'worktree/merge': async (params) => worktrees.merge(parseParams('worktree/merge', params)),
  };
}

/** Register all 7 manager methods on a daemon instance. */
export function registerManagerMethods(daemon: SundayDaemon): void {
  const handlers = createManagerHandlers();
  for (const [method, handler] of Object.entries(handlers) as Array<[ManagerMethodName, ManagerHandler]>) {
    daemon.registerMethod(method, handler);
  }
}
