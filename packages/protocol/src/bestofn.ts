import { z } from 'zod';

/**
 * `bestofn/*` — Group A, A2: best-of-N parallel attempts.
 *
 * The IDE asks sundayd to run N parallel variants of one goal
 * (`bestofn/run`); each variant works in its own git worktree on a
 * dedicated `sunday/bestofn/*` branch. The comparison view shows the
 * per-attempt diffs, and "Pick winner" merges that attempt's branch via
 * the existing `worktree/merge` method.
 *
 * Method names follow the product's `a/b` convention:
 *   - `bestofn/run` — run N variants, returns per-attempt diffs
 */

export const bestofnRunParamsSchema = z.object({
  goal: z.string().min(1).max(8000),
  /** 1..8 parallel variants. */
  attempts: z.number().int().min(1).max(8).default(3),
  /** Absolute path of the working directory (must be a git repo). */
  workdir: z.string().min(1),
});
export type BestofnRunParams = z.infer<typeof bestofnRunParamsSchema>;

export const bestofnAttemptSchema = z.object({
  id: z.string().min(1),
  temperature: z.number(),
  angle: z.enum(['conservative', 'balanced', 'creative']),
  summary: z.string(),
  diff: z.string(),
  filesChanged: z.array(z.string()),
  /** Worktree path holding this attempt's changes (for worktree/merge). */
  worktree: z.string().min(1),
  branch: z.string().min(1),
  error: z.string().optional(),
});
export type BestofnAttempt = z.infer<typeof bestofnAttemptSchema>;

export const bestofnRunResultSchema = z.object({
  attempts: z.array(bestofnAttemptSchema),
});
export type BestofnRunResult = z.infer<typeof bestofnRunResultSchema>;

/** Method registry for `bestofn/*` — same shape as the other `*_METHODS`. */
export const BESTOFN_METHODS = {
  'bestofn/run': {
    params: bestofnRunParamsSchema,
    result: bestofnRunResultSchema,
  },
} as const;
export type BestofnMethodName = keyof typeof BESTOFN_METHODS;
