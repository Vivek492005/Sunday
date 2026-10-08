/**
 * Sunday entitlements — shared types + cache contract (Phase 9.b).
 *
 * A *plan* is what the user bought (basic/smart/pro). An *entitlement* is a
 * specific checkable permission/limit. Client code NEVER hard-codes
 * "if plan == pro" — it checks entitlement keys via `getEntitlements()`.
 *
 * This file is the CONTRACT. `entitlementsCache.ts` (Task 6) implements it;
 * gated features (Task 7) consume only these exports.
 */

/** All entitlement keys (must match the gateway's plans.json). */
export type EntitlementKey =
  | 'managed_models.enabled'
  | 'managed_models.daily_requests'
  | 'orchestration.max_feature_agents'
  | 'orchestration.parallel'
  | 'browser_agent.enabled'
  | 'browser_agent.daily_sessions'
  | 'codebase_index.max_repo_mb'
  | 'autocomplete.managed_route'
  | 'scheduler.priority_class'
  | 'support.tier';

export type EntitlementValue = boolean | number | string;

export type Entitlements = Record<EntitlementKey, EntitlementValue>;

export type PlanId = 'basic' | 'smart' | 'pro';

export interface EntitlementsView {
  user_id: string;
  plan: PlanId;
  status: 'active' | 'past_due' | 'cancelling' | 'cancelled';
  renews_at: string | null;
  entitlements: Entitlements;
  cached_at: string;
  valid_until: string;
}

/** Where the returned entitlements came from (for UI/debugging). */
export type EntitlementsSource = 'fresh' | 'cache' | 'grace' | 'fallback' | 'signed-out';

export interface EntitlementsResult {
  view: EntitlementsView;
  source: EntitlementsSource;
}

/**
 * Get the current entitlements, resolving in this order:
 *   1. fresh  — valid cache (valid_until in future), or successful GET /me/entitlements
 *   2. cache  — (same as fresh; kept as a distinct label for the fetch path)
 *   3. grace  — backend unreachable, cache expired but within 72h grace window
 *   4. fallback — grace lapsed: Basic-equivalent, managed routes disabled
 *   5. signed-out — no Sunday session: local-only entitlements (same as fallback)
 *
 * NEVER throws for network problems — degrades to grace/fallback instead.
 * NEVER returns managed access the gateway wouldn't grant: the gateway
 * re-checks entitlements server-side on every managed request, so a stale
 * or tampered cache can only hide UI, never bypass limits.
 */
export interface EntitlementsProvider {
  getEntitlements(): Promise<EntitlementsResult>;
  /** Synchronous read of the last-known view (undefined when never fetched). */
  getCachedSync(): EntitlementsView | undefined;
  /** Force a refetch from the gateway (used by the refresh command). */
  refresh(): Promise<EntitlementsResult>;
  /** Clear cached state (called on sign-out). */
  clear(): void;
}

/** Convenience accessors over an EntitlementsView. */
export function canUseManagedModels(view: EntitlementsView): boolean {
  return view.entitlements['managed_models.enabled'] === true;
}

export function maxFeatureAgents(view: EntitlementsView): number {
  const v = view.entitlements['orchestration.max_feature_agents'];
  return typeof v === 'number' ? v : 1;
}

export function canRunParallel(view: EntitlementsView): boolean {
  return view.entitlements['orchestration.parallel'] === true;
}

export function canUseBrowserAgent(view: EntitlementsView): boolean {
  return view.entitlements['browser_agent.enabled'] === true;
}

export function maxRepoMb(view: EntitlementsView): number {
  const v = view.entitlements['codebase_index.max_repo_mb'];
  return typeof v === 'number' ? v : 100;
}

export function dailyRequestLimit(view: EntitlementsView): number {
  const v = view.entitlements['managed_models.daily_requests'];
  return typeof v === 'number' ? v : 0;
}
