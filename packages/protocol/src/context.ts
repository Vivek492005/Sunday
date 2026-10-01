import { z } from 'zod';

/** A single file in the workspace repo map (§Phase 2). `path` is posix-style,
 *  relative to the workspace root. */
export const repoFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  lang: z.string().min(1),
});
export type RepoFile = z.infer<typeof repoFileSchema>;

/** A ranked retrieval hit over the workspace index. Line numbers are 1-based. */
export const searchHitSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  score: z.number(),
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

/** Context method registry (§Phase 2): repo map, indexer, retrieval. Same
 *  shape as the other `*_METHODS` registries: params/result zod schemas. */
export const CONTEXT_METHODS = {
  'context/map': {
    params: z.object({ workspaceRoot: z.string().min(1) }),
    result: z.object({
      files: z.array(repoFileSchema),
      totalFiles: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
    }),
  },
  'context/index': {
    params: z.object({
      workspaceRoot: z.string().min(1),
      force: z.boolean().optional(),
    }),
    result: z.object({
      files: z.number().int().nonnegative(),
      chunks: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
  },
  'context/search': {
    params: z.object({
      workspaceRoot: z.string().min(1).optional(),
      query: z.string().min(1),
      k: z.number().int().positive().max(50).optional(),
      maxChars: z.number().int().positive().max(100_000).optional(),
    }),
    result: z.object({ hits: z.array(searchHitSchema) }),
  },
} as const;
export type ContextMethodName = keyof typeof CONTEXT_METHODS;
