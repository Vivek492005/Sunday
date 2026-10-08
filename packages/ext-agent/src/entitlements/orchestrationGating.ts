// sunday-agent — orchestration entitlement caps (Task 7).
//
// Pure resolution of the effective `parallel` / `maxParallel` params for
// `orchestrate/run` from the user's entitlements. The daemon ALSO re-applies
// the raw caps in @sunday/orchestrator's runner (defence in depth) — this
// module is the IDE-side computation plus the caps object forwarded to it.

import {
  canRunParallel,
  maxFeatureAgents,
  type EntitlementsView,
} from './types.js';

/** Pool size the parallel runner uses when the caller doesn't ask for one. */
export const DEFAULT_MAX_PARALLEL = 3;
/** Hard ceiling — mirrors MAX_PLAN_UNITS in @sunday/protocol. */
export const MAX_PARALLEL_CEILING = 8;

export interface OrchestrationCapsInput {
  requestedParallel: boolean;
  requestedMaxParallel?: number;
  view: EntitlementsView | undefined;
}

export interface ResolvedOrchestrationCaps {
  /** Effective `parallel` param for `orchestrate/run`. */
  parallel: boolean;
  /** Effective `maxParallel` param for `orchestrate/run`. */
  maxParallel: number;
  /** True when the entitlement cap reduced the requested pool size. */
  capped: boolean;
  /** One-line note appended to the plan artifact when `capped`. */
  capNote?: string;
  /**
   * Raw caps forwarded to the daemon (`entitlementCaps` param) so the
   * runner re-enforces them server-side. Absent when entitlements unknown.
   */
  entitlementCaps?: { maxFeatureAgents: number; parallelAllowed: boolean };
}

/**
 * Resolve orchestration caps (pure, testable):
 * - `view` undefined → fail open: requested values pass through uncapped.
 * - `maxParallel = min(requested, orchestration.max_feature_agents)`.
 * - `!orchestration.parallel` → force `parallel: false`, even when the
 *   plan's paths don't overlap (the overlap gate alone must not enable it).
 */
export function resolveOrchestrationCaps(input: OrchestrationCapsInput): ResolvedOrchestrationCaps {
  const requested = Math.max(
    1,
    Math.min(Math.floor(input.requestedMaxParallel ?? DEFAULT_MAX_PARALLEL), MAX_PARALLEL_CEILING),
  );
  const { view } = input;
  if (!view) {
    return { parallel: input.requestedParallel, maxParallel: requested, capped: false };
  }
  const cap = Math.max(1, Math.floor(maxFeatureAgents(view)));
  const parallelAllowed = canRunParallel(view);
  const maxParallel = Math.min(requested, cap);
  const capped = maxParallel < requested;
  return {
    parallel: input.requestedParallel && parallelAllowed,
    maxParallel,
    capped,
    capNote: capped ? `Capped at ${maxParallel} agents on your plan` : undefined,
    entitlementCaps: { maxFeatureAgents: cap, parallelAllowed },
  };
}
