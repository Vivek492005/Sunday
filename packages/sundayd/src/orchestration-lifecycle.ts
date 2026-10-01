import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * sundayd — Parallel Agents: orchestration run persistence lifecycle
 * (Worker 2 wiring).
 *
 * The store (`FileOrchestrationStateStore`) and the reconciler
 * (`reconcileOrchestrationRuns`) live in @sunday/orchestrator (Worker 1).
 * This module is the daemon-side seam: it constructs the store with the
 * daemon's dir convention and runs reconciliation at startup. Everything is
 * structural (no @sunday/orchestrator import — not even types) so the
 * package edge stays one-directional and the daemon keeps building and
 * starting against an older orchestrator dist; persistence then degrades to
 * a logged warning instead of crashing the daemon.
 *
 * Note: the constructed store is NOT passed into the orchestration handlers.
 * Worker 1's design keeps the active-runs registry module-level inside
 * @sunday/orchestrator, and `getOrchestrationRunState` already falls back to
 * the persisted `~/.sunday/orchestrations/<runId>.json` file — so
 * stop/status/merge/resolveConflict work across restarts with no extra
 * wiring. The daemon's only store duty is constructing it for reconcile.
 */

/** Same convention as sessions.ts `defaultSessionsDir`. */
export function defaultOrchestrationsDir(): string {
  return join(homedir(), '.sunday', 'orchestrations');
}

/**
 * Structural slice of @sunday/orchestrator needed at daemon setup.
 * `reconcileOrchestrationRuns(store)` marks runs left non-terminal by a
 * crash/shutdown as 'interrupted' (best-effort worktree cleanup via its
 * optional second arg — not passed here: see below).
 */
export interface OrchestrationPersistenceModule {
  FileOrchestrationStateStore?: new (dir?: string) => unknown;
  reconcileOrchestrationRuns?: (store: unknown) => Promise<unknown>;
}

/**
 * Build the run store and reconcile stale runs. Logs the outcome to stderr
 * (cli.ts keeps stdout for the NDJSON frame stream). Never throws: a
 * persistence failure degrades to in-memory-only run state rather than
 * taking the daemon down.
 *
 * Worktree cleanup is deliberately NOT passed to reconcile: the persisted
 * run state carries no workspaceRoot, and worktree paths are content-hashed
 * (see WorktreeManager.defaultPath), so the daemon cannot derive a safe
 * repoRoot for `worktree/remove`. Stale worktrees are left on disk for the
 * user to clean up. (Follow-up for Worker 1: persist workspaceRoot per run
 * to enable best-effort removal here.)
 */
export async function setupOrchestrationPersistence(
  mod: OrchestrationPersistenceModule,
  log: (msg: string) => void = (m) => console.error(m),
): Promise<unknown> {
  const Ctor = mod.FileOrchestrationStateStore;
  const reconcile = mod.reconcileOrchestrationRuns;
  if (typeof Ctor !== 'function' || typeof reconcile !== 'function') {
    log(
      '[sundayd] orchestration persistence unavailable ' +
        '(the @sunday/orchestrator build predates the Parallel Agents phase) — run state stays in-memory only',
    );
    return undefined;
  }
  try {
    const dir = defaultOrchestrationsDir();
    const store = new Ctor(dir);
    await reconcile(store);
    log(`[sundayd] orchestration runs reconciled (store: ${dir})`);
    return store;
  } catch (e) {
    log(`[sundayd] orchestration reconcile failed: ${(e as Error).message} — continuing without run recovery`);
    return undefined;
  }
}
