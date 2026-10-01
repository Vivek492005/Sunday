/**
 * @sunday/orchestrator — Phase 5: hierarchical orchestration
 * (Orchestrator → Feature Agents → Verifier), sequential-only v1 (ADR-17).
 *
 * Every participant is an ordinary sundayd agent-loop session; this package
 * is the coordination layer above the loop (§9.9): planning (model call with
 * role=planner), delegation into isolated git worktrees, per-slice black-box
 * verification (ADR-16), and a request-budget estimate surfaced before any
 * delegation (ADR-18).
 *
 * Method names follow the product's `a/b` convention (e.g. `context/map`):
 *   - `orchestrate/plan` — decompose a goal into contracted units + budget
 *   - `orchestrate/run`  — run the units sequentially, streaming progress
 *   - `orchestrate/event` — progress notification (daemon → client)
 *
 * The `orchestrate/*` wire schemas live in @sunday/protocol (so the daemon's
 * central METHODS registry knows them) and are re-exported here. What stays
 * here are the orchestrator's private contracts for the daemon primitives
 * it consumes verbatim via host.dispatch.
 *
 * Worktree/checkpoint primitives (`worktree/add`, `worktree/merge`,
 * `worktree/remove`, `checkpoint/create`) are consumed verbatim through the
 * host's dispatch — they are implemented by the daemon, not here.
 */
export {
  plannedUnitSchema,
  planDraftSchema,
  planResultSchema,
  planParamsSchema,
  runParamsSchema,
  orchestrationPhaseSchema,
  orchestrationEventSchema,
  unitResultSchema,
  runResultSchema,
  ORCHESTRATE_METHODS,
  ORCHESTRATE_NOTIFICATIONS,
  MAX_PLAN_UNITS,
  MAX_UNIT_RETRIES,
  // Parallel-agents run registry state + merge conflicts (shared contract).
  unitRunStatusSchema,
  runStatusSchema,
  unitRunStateSchema,
  conflictHunkSchema,
  mergeConflictSchema,
  conflictResolutionSchema,
  orchestrationRunStateSchema,
  orchestrateStopParamsSchema,
  orchestrateStopResultSchema,
  orchestrateStatusParamsSchema,
  orchestrateMergeResultSchema,
  orchestrateResolveConflictParamsSchema,
} from '@sunday/protocol';
export type {
  PlannedUnit,
  PlanDraft,
  OrchestrationPlan,
  PlanParams,
  RunParams,
  OrchestrationPhase,
  OrchestrationEvent,
  UnitResult,
  OrchestrationRunResult,
  OrchestrateMethodName,
  UnitRunStatus,
  RunStatus,
  UnitRunState,
  ConflictHunk,
  MergeConflict,
  ConflictResolution,
  OrchestrationRunState,
  OrchestrateStopParams,
  OrchestrateStopResult,
  OrchestrateStatusParams,
  OrchestrateMergeResult,
  OrchestrateResolveConflictParams,
} from '@sunday/protocol';

import { z } from 'zod';

/* ---- Verbatim external contracts (implemented by the daemon) ---- */

export const worktreeAddResultSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
});

export const worktreeMergeResultSchema = z.object({
  merged: z.boolean(),
  sha: z.string().min(1),
  target: z.string().min(1),
});

export const worktreeRemoveResultSchema = z.object({
  removed: z.boolean(),
});

export const checkpointCreateResultSchema = z.object({
  id: z.string().min(1),
  sha: z.string().min(1),
  createdAt: z.string().min(1),
});
