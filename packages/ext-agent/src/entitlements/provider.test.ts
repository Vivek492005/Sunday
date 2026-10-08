// Tests for the entitlements provider seam: registration, the throwing
// getter, and the fail-open reads.
import { describe, expect, it, beforeEach } from 'vitest';
import {
  getCachedView,
  getEntitlementsView,
  getProvider,
  getProviderOrUndefined,
  provider,
  resetEntitlementsProviderForTests,
  setEntitlementsProvider,
} from './provider.js';
import type { EntitlementsProvider, EntitlementsView } from './types.js';

function makeView(): EntitlementsView {
  return {
    user_id: 'u-1',
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
    },
    cached_at: new Date().toISOString(),
    valid_until: new Date().toISOString(),
  };
}

function makeProvider(view: EntitlementsView): EntitlementsProvider {
  return {
    getEntitlements: async () => ({ view, source: 'fresh' }),
    getCachedSync: () => view,
    refresh: async () => ({ view, source: 'fresh' }),
    clear: () => undefined,
  };
}

describe('entitlements provider seam', () => {
  beforeEach(() => resetEntitlementsProviderForTests());

  it('getProvider throws a clear error before registration', () => {
    expect(() => getProvider()).toThrow(/not set.*setEntitlementsProvider/);
    expect(getProviderOrUndefined()).toBeUndefined();
  });

  it('setEntitlementsProvider registers the provider', () => {
    const p = makeProvider(makeView());
    setEntitlementsProvider(p);
    expect(getProvider()).toBe(p);
    expect(provider).toBe(p);
  });

  it('getEntitlementsView returns undefined (fail open) when unset', async () => {
    const logs: string[] = [];
    await expect(getEntitlementsView((m) => logs.push(m))).resolves.toBeUndefined();
    expect(logs).toEqual([]);
  });

  it('getEntitlementsView returns the view once registered', async () => {
    const view = makeView();
    setEntitlementsProvider(makeProvider(view));
    await expect(getEntitlementsView()).resolves.toBe(view);
  });

  it('getEntitlementsView fails open when the provider throws', async () => {
    const logs: string[] = [];
    setEntitlementsProvider({
      getEntitlements: async () => {
        throw new Error('network down');
      },
      getCachedSync: () => undefined,
      refresh: async () => {
        throw new Error('network down');
      },
      clear: () => undefined,
    });
    await expect(getEntitlementsView((m) => logs.push(m))).resolves.toBeUndefined();
    expect(logs.some((m) => m.includes('failing open'))).toBe(true);
  });

  it('getCachedView is sync and fails open on a throwing cache', () => {
    const logs: string[] = [];
    setEntitlementsProvider({
      getEntitlements: async () => {
        throw new Error('x');
      },
      getCachedSync: () => {
        throw new Error('cache corrupt');
      },
      refresh: async () => {
        throw new Error('x');
      },
      clear: () => undefined,
    });
    expect(getCachedView((m) => logs.push(m))).toBeUndefined();
    expect(logs.some((m) => m.includes('failing open'))).toBe(true);
  });

  it('getCachedView returns the cached view', () => {
    const view = makeView();
    setEntitlementsProvider(makeProvider(view));
    expect(getCachedView()).toBe(view);
  });
});
