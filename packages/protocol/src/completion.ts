import { z } from 'zod';

/** Ghost-text inline completion surface (Part B). The extension extracts
 *  prefix/suffix around the cursor and asks sundayd for a completion; the
 *  sidecar owns debounce, caching, and the provider call (§10 FIM). */

export const completionPositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});

export const completionParamsSchema = z.object({
  /** Document URI (also the debounce/coalescing key). */
  uri: z.string().min(1),
  position: completionPositionSchema,
  /** Text before the cursor (extension-extracted, bounded). */
  prefix: z.string().max(8000),
  /** Text after the cursor; dropped on providers without native FIM. */
  suffix: z.string().max(2000).optional(),
  /** Editor document version — part of the cache key (edit invalidation). */
  docVersion: z.number().int(),
  /** "provider:model" ref; defaults to the fast/cheap completion model. */
  model: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().max(256).optional(),
});
export type CompletionParams = z.infer<typeof completionParamsSchema>;

export const completionResultSchema = z.object({
  /** Raw completion text for the cursor position ('' when none). */
  completion: z.string(),
  /** True when served from the orchestrator's LRU cache. */
  cached: z.boolean(),
  /** True when the provider served this via a native FIM endpoint. */
  nativeFim: z.boolean(),
  /** True when superseded by a newer request for the same document. */
  cancelled: z.boolean(),
  /** Wall-clock ms for the provider call (0 on cache hit / cancel). */
  latencyMs: z.number().nonnegative(),
});
export type CompletionResult = z.infer<typeof completionResultSchema>;

export const completionStatsSchema = z.object({
  /** Total completed provider calls recorded in the window. */
  count: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  cacheMisses: z.number().int().nonnegative(),
  /** Sliding-window latency percentiles over completed calls (ms). */
  p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  avgMs: z.number().nonnegative(),
  /** Currently in-flight provider calls. */
  inFlight: z.number().int().nonnegative(),
});
export type CompletionStats = z.infer<typeof completionStatsSchema>;

export const COMPLETION_METHODS = {
  'completion/complete': {
    params: completionParamsSchema,
    result: completionResultSchema,
  },
  'completion/stats': {
    params: z.object({}),
    result: completionStatsSchema,
  },
} as const;
