import { z } from 'zod';

/**
 * @sunday/protocol — `orchestrate/*` method schemas (Phase 5: hierarchical
 * orchestration, Orchestrator → Feature Agents → Verifier, sequential-only
 * v1 per ADR-17).
 *
 * These live in the protocol package (like `manager.ts` / `browser.ts`) so
 * the daemon's central METHODS registry — and its MethodNotFound dispatch
 * check — knows the orchestration methods. The coordination logic itself
 * lives in @sunday/orchestrator, which re-exports these schemas.
 */

/** One decomposed unit of work — the task contract (§9.9.4). */
export const plannedUnitSchema = z.object({
  /** URL-safe slug, also used for the worktree branch `sunday/feat/<id>`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(200),
  /** Machine-checkable file ownership; feeds the plan-time overlap check. */
  owns_paths: z.array(z.string().min(1).max(300)).min(1).max(20),
  /** Concrete, mechanically checkable success criteria (full suite + a
   *  negative test — the contract lint from §9.9.4/§9.9.7). */
  acceptance: z.array(z.string().min(1).max(500)).min(1).max(20),
  /** Estimated model requests for this unit (drives max-steps + ADR-18). */
  budget: z.number().int().min(1).max(200),
});
export type PlannedUnit = z.infer<typeof plannedUnitSchema>;

/** What the planner model is asked to emit (units only — the budget is
 *  computed by the orchestrator, never trusted from the model). */
export const planDraftSchema = z.object({
  units: z.array(plannedUnitSchema).min(1),
});
export type PlanDraft = z.infer<typeof planDraftSchema>;

/** Hard cap from §9.9.3: never emit more than 8 units. */
export const MAX_PLAN_UNITS = 8;
/** FIXING-state retries per unit (initial attempt + this many re-delegations). */
export const MAX_UNIT_RETRIES = 2;

export const planResultSchema = z.object({
  units: z.array(plannedUnitSchema).min(1).max(MAX_PLAN_UNITS),
  /** ADR-18: sum(unit budgets) + one verification pass per unit + the
   *  planner call itself — surfaced BEFORE any delegation happens. */
  totalBudget: z.number().int().nonnegative(),
});
export type OrchestrationPlan = z.infer<typeof planResultSchema>;

export const planParamsSchema = z.object({
  goal: z.string().min(1).max(4000),
  workspaceRoot: z.string().min(1),
  model: z.string().min(1).optional(),
});
export type PlanParams = z.infer<typeof planParamsSchema>;

export const runParamsSchema = planParamsSchema.extend({
  /** Skip planning when the caller already has an approved plan. The overlap
   *  check is re-run on supplied plans — a hand-made plan is not trusted. */
  plan: planDraftSchema.optional(),
  /** Parallel agents (ADR-17): run units concurrently in separate worktrees.
   *  Default false — sequential until the parallel benchmark passes. */
  parallel: z.boolean().optional(),
  /** Max concurrent units when parallel is true. */
  maxParallel: z.number().int().min(1).max(MAX_PLAN_UNITS).optional(),
});
export type RunParams = z.infer<typeof runParamsSchema>;

export const orchestrationPhaseSchema = z.enum([
  'planned',
  'queued',
  'started',
  'verifying',
  'merged',
  'failed',
  'conflicted',
]);
export type OrchestrationPhase = z.infer<typeof orchestrationPhaseSchema>;

export const orchestrationEventSchema = z.object({
  runId: z.string().min(1),
  unitId: z.string(),
  phase: orchestrationPhaseSchema,
  detail: z.string().max(2000).optional(),
});
export type OrchestrationEvent = z.infer<typeof orchestrationEventSchema>;

export const unitResultSchema = z.object({
  id: z.string().min(1),
  /** 'cancelled' is parallel-mode only: the unit never ran to a verdict. */
  status: z.enum(['merged', 'failed', 'cancelled']),
  /** HEAD sha recorded by `worktree/merge` (present on merged units). */
  sha: z.string().optional(),
});
export type UnitResult = z.infer<typeof unitResultSchema>;

export const runResultSchema = z.object({
  units: z.array(unitResultSchema),
  /** Last successful merge sha (absent when nothing merged). */
  mergedSha: z.string().optional(),
});
export type OrchestrationRunResult = z.infer<typeof runResultSchema>;

/* ---- Parallel agents: run registry state, merge conflicts (shared contract) ---- */

export const unitRunStatusSchema = z.enum([
  'queued',
  'running',
  'verifying',
  'done',
  'failed',
  'cancelled',
]);
export type UnitRunStatus = z.infer<typeof unitRunStatusSchema>;

export const runStatusSchema = z.enum([
  'running',
  'conflicted',
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const unitRunStateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: unitRunStatusSchema,
  worktreePath: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  steps: z.number().int().nonnegative().optional(),
  sha: z.string().optional(),
  error: z.string().optional(),
});
export type UnitRunState = z.infer<typeof unitRunStateSchema>;

export const conflictHunkSchema = z.object({
  file: z.string().min(1),
  unitA: z.string().min(1),
  unitB: z.string().min(1),
  rangeA: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  rangeB: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
});
export type ConflictHunk = z.infer<typeof conflictHunkSchema>;

export const mergeConflictSchema = z.object({
  index: z.number().int().nonnegative(),
  file: z.string().min(1),
  hunks: z.array(conflictHunkSchema),
});
export type MergeConflict = z.infer<typeof mergeConflictSchema>;

export const conflictResolutionSchema = z.object({
  conflictIndex: z.number().int().nonnegative(),
  keepUnitId: z.string().min(1),
});
export type ConflictResolution = z.infer<typeof conflictResolutionSchema>;

export const orchestrationRunStateSchema = z.object({
  runId: z.string().min(1),
  goal: z.string().min(1),
  parallel: z.boolean(),
  status: runStatusSchema,
  units: z.array(unitRunStateSchema),
  conflicts: z.array(mergeConflictSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OrchestrationRunState = z.infer<typeof orchestrationRunStateSchema>;

export const orchestrateStopParamsSchema = z.object({ runId: z.string().min(1) });
export type OrchestrateStopParams = z.infer<typeof orchestrateStopParamsSchema>;

export const orchestrateStopResultSchema = z.object({ stopped: z.boolean() });
export type OrchestrateStopResult = z.infer<typeof orchestrateStopResultSchema>;

export const orchestrateStatusParamsSchema = z.object({ runId: z.string().min(1) });
export type OrchestrateStatusParams = z.infer<typeof orchestrateStatusParamsSchema>;

export const orchestrateMergeResultSchema = z.object({
  conflicts: z.array(mergeConflictSchema),
  merged: z.array(z.string().min(1)),
});
export type OrchestrateMergeResult = z.infer<typeof orchestrateMergeResultSchema>;

export const orchestrateResolveConflictParamsSchema = z.object({
  runId: z.string().min(1),
  resolutions: z.array(conflictResolutionSchema).min(1),
});
export type OrchestrateResolveConflictParams = z.infer<typeof orchestrateResolveConflictParamsSchema>;

/** Method registry for `orchestrate/*` — same shape as the other `*_METHODS`
 *  tables so the daemon validates params/results uniformly. */
export const ORCHESTRATE_METHODS = {
  'orchestrate/plan': { params: planParamsSchema, result: planResultSchema },
  'orchestrate/run': { params: runParamsSchema, result: runResultSchema },
  'orchestrate/stop': { params: orchestrateStopParamsSchema, result: orchestrateStopResultSchema },
  'orchestrate/status': { params: orchestrateStatusParamsSchema, result: orchestrationRunStateSchema },
  'orchestrate/merge': { params: orchestrateStatusParamsSchema, result: orchestrateMergeResultSchema },
  'orchestrate/resolveConflict': {
    params: orchestrateResolveConflictParamsSchema,
    result: orchestrateMergeResultSchema,
  },
} as const;
export type OrchestrateMethodName = keyof typeof ORCHESTRATE_METHODS;

export const ORCHESTRATE_NOTIFICATIONS = {
  'orchestrate/event': orchestrationEventSchema,
} as const;
