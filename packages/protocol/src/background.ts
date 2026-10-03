import { z } from 'zod';

/**
 * `background/*` — Phase 8: background agents with PR creation.
 *
 * A background run is a fire-and-forget agent task: `background/run`
 * returns a `runId` immediately while the daemon executes the run detached
 * (it survives the editor closing because it lives in the per-user sundayd,
 * not in any window). The agent works in an isolated git worktree on a
 * dedicated branch; on success the branch is pushed and a GitHub PR is
 * created. Progress and completion stream as `background/event`
 * notifications. PRs are NEVER auto-merged — a human merges.
 *
 * Method names follow the product's `a/b` convention:
 *   - `background/run`    — start a detached run, returns { runId }
 *   - `background/status` — query run state (works across daemon restarts:
 *                           state is file-backed)
 *   - `background/cancel` — abort a queued/running run
 *   - `background/event`  — lifecycle notification (daemon → client)
 */

export const backgroundRunParamsSchema = z.object({
  goal: z.string().min(1).max(8000),
  workspaceRoot: z.string().min(1),
  model: z.string().min(1).optional(),
  /** Base branch the work branches from. Defaults to the repo's default. */
  baseBranch: z.string().min(1).optional(),
  /** Short human title used for the branch/PR title. Defaults to a goal slug. */
  title: z.string().min(1).max(120).optional(),
});
export type BackgroundRunParams = z.infer<typeof backgroundRunParamsSchema>;

export const backgroundRunResultSchema = z.object({
  runId: z.string().min(1),
});
export type BackgroundRunResult = z.infer<typeof backgroundRunResultSchema>;

export const backgroundRunStatusSchema = z.enum([
  'queued',
  'running',
  'committing',
  'pr-creating',
  'pr-created',
  'failed',
  'cancelled',
]);
export type BackgroundRunStatus = z.infer<typeof backgroundRunStatusSchema>;

/** Run statuses that need no further action (reconcile leaves them alone). */
export const TERMINAL_BACKGROUND_STATUSES: readonly BackgroundRunStatus[] = [
  'pr-created',
  'failed',
  'cancelled',
];

export const backgroundRunStateSchema = z.object({
  runId: z.string().min(1),
  goal: z.string().min(1),
  workspaceRoot: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  status: backgroundRunStatusSchema,
  prUrl: z.string().url().optional(),
  prNumber: z.number().int().positive().optional(),
  error: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type BackgroundRunState = z.infer<typeof backgroundRunStateSchema>;

export const backgroundStatusParamsSchema = z.object({ runId: z.string().min(1) });
export type BackgroundStatusParams = z.infer<typeof backgroundStatusParamsSchema>;

export const backgroundCancelParamsSchema = z.object({ runId: z.string().min(1) });
export type BackgroundCancelParams = z.infer<typeof backgroundCancelParamsSchema>;

export const backgroundCancelResultSchema = z.object({ cancelled: z.boolean() });
export type BackgroundCancelResult = z.infer<typeof backgroundCancelResultSchema>;

export const backgroundEventSchema = z.object({
  runId: z.string().min(1),
  phase: backgroundRunStatusSchema,
  detail: z.string().optional(),
});
export type BackgroundEvent = z.infer<typeof backgroundEventSchema>;

/** Method registry for `background/*` — same shape as the other `*_METHODS`
 *  tables so the daemon validates params/results uniformly. */
export const BACKGROUND_METHODS = {
  'background/run': { params: backgroundRunParamsSchema, result: backgroundRunResultSchema },
  'background/status': { params: backgroundStatusParamsSchema, result: backgroundRunStateSchema },
  'background/cancel': { params: backgroundCancelParamsSchema, result: backgroundCancelResultSchema },
} as const;
export type BackgroundMethodName = keyof typeof BACKGROUND_METHODS;

export const BACKGROUND_NOTIFICATIONS = {
  'background/event': backgroundEventSchema,
} as const;
