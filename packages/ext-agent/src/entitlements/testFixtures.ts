// Shared fixture for entitlements gate tests: builds an EntitlementsView
// without hard-coding plan names — callers pass entitlement values.
import type { Entitlements, EntitlementsView } from './types.js';

export function makeView(entitlements: Partial<Entitlements>): EntitlementsView {
  return {
    user_id: 'u-test',
    plan: 'basic',
    status: 'active',
    renews_at: null,
    entitlements: {
      'managed_models.enabled': true,
      'managed_models.daily_requests': 200,
      'orchestration.max_feature_agents': 1,
      'orchestration.parallel': false,
      'browser_agent.enabled': false,
      'browser_agent.daily_sessions': 0,
      'codebase_index.max_repo_mb': 100,
      'autocomplete.managed_route': false,
      'scheduler.priority_class': 'standard',
      'support.tier': 'community',
      ...entitlements,
    },
    cached_at: new Date().toISOString(),
    valid_until: new Date(Date.now() + 3600_000).toISOString(),
  };
}
