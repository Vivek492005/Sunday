import { z } from 'zod';

/** A recorded workspace snapshot (§Phase 4). `id` is the shadow-repo commit
 *  sha; the shadow repo lives under `~/.sunday/workspaces/<sha>/checkpoints.git`
 *  — never inside the user's workspace. */
export const checkpointSchema = z.object({
  id: z.string().min(1),
  sha: z.string().min(1),
  label: z.string(),
  createdAt: z.string(), // ISO-8601 (shadow-repo committer date)
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

/** A git worktree attached to a repo (§Phase 4). `branch` is empty when the
 *  worktree is on a detached HEAD. */
export const worktreeSchema = z.object({
  path: z.string().min(1),
  branch: z.string(),
  head: z.string().min(1),
});
export type Worktree = z.infer<typeof worktreeSchema>;

/** Manager method registry (§Phase 4): checkpoints + worktrees. Same shape as
 *  the other `*_METHODS` registries: params/result zod schemas. Phase 5
 *  consumes these method names verbatim — do not rename. */
export const MANAGER_METHODS = {
  'checkpoint/create': {
    params: z.object({
      workspaceRoot: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      label: z.string().max(200).optional(),
    }),
    result: z.object({
      id: z.string().min(1),
      sha: z.string().min(1),
      createdAt: z.string(),
    }),
  },
  'checkpoint/list': {
    params: z.object({ workspaceRoot: z.string().min(1) }),
    result: z.object({ checkpoints: z.array(checkpointSchema) }),
  },
  'checkpoint/restore': {
    params: z.object({
      workspaceRoot: z.string().min(1),
      id: z.string().min(1),
    }),
    result: z.object({
      id: z.string().min(1),
      sha: z.string().min(1),
      filesRestored: z.number().int().nonnegative(),
    }),
  },
  'worktree/add': {
    params: z.object({
      repoRoot: z.string().min(1),
      branch: z.string().min(1),
      path: z.string().optional(),
    }),
    result: z.object({
      path: z.string().min(1),
      branch: z.string().min(1),
    }),
  },
  'worktree/list': {
    params: z.object({ repoRoot: z.string().min(1) }),
    result: z.object({ worktrees: z.array(worktreeSchema) }),
  },
  'worktree/remove': {
    params: z.object({
      repoRoot: z.string().min(1),
      path: z.string().min(1),
      force: z.boolean().optional(),
    }),
    result: z.object({ removed: z.literal(true) }),
  },
  'worktree/merge': {
    params: z.object({
      repoRoot: z.string().min(1),
      path: z.string().min(1),
      target: z.string().optional(),
    }),
    result: z.object({
      merged: z.literal(true),
      sha: z.string().min(1),
      target: z.string().min(1),
    }),
  },
} as const;
export type ManagerMethodName = keyof typeof MANAGER_METHODS;
