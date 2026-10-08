// Tests for the entitlements cache (Task 6): cache resolution order, grace
// window, fallback, 401 handling, and the never-throw guarantee. `vscode` is
// not touched at runtime — the cache takes globalState + fetch + session as
// injectable deps, all mocked here.
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  createEntitlementsCache,
  fallbackEntitlements,
  isValidView,
  signedOutView,
  ENTITLEMENT_KEYS,
  ENTITLEMENTS_FETCH_TIMEOUT_MS,
  ENTITLEMENTS_GRACE_WINDOW_MS,
  type EntitlementsCacheDeps,
  type EntitlementsGlobalState,
  type FetchLike,
} from './entitlementsCache.js';
import type { Entitlements, EntitlementsView } from './types.js';

const FIXED_NOW = Date.UTC(2026, 9, 8, 5, 0, 0);
const HOUR = 60 * 60 * 1000;

function validEntitlements(): Entitlements {
  return {
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
  };
}

function makeView(overrides: Partial<EntitlementsView> = {}): EntitlementsView {
  return {
    user_id: 'user-1',
    plan: 'pro',
    status: 'active',
    renews_at: null,
    entitlements: validEntitlements(),
    cached_at: new Date(FIXED_NOW).toISOString(),
    valid_until: new Date(FIXED_NOW + HOUR).toISOString(),
    ...overrides,
  };
}

function makeGlobalState(): EntitlementsGlobalState & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
}

type FetchResult = { ok: boolean; status: number; body?: unknown; throws?: unknown };

function makeFetch(result: FetchResult): { fetchFn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls.push(url);
    if (result.throws !== undefined) throw result.throws;
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.body,
    };
  };
  return { fetchFn, calls };
}

function gatewayPayload(plan: 'basic' | 'smart' | 'pro' = 'pro') {
  return { plan, entitlements: validEntitlements() };
}

function makeDeps(overrides: Partial<EntitlementsCacheDeps> = {}) {
  const onUnauthorized = vi.fn();
  const globalState = makeGlobalState();
  const deps: EntitlementsCacheDeps = {
    getSundaySession: async () => ({ sessionToken: 'session-jwt', user: { id: 'user-1' } }),
    fetchFn: makeFetch({ ok: true, status: 200, body: gatewayPayload() }).fetchFn,
    gatewayUrl: 'https://gw.test',
    onUnauthorized,
    log: () => undefined,
    now: () => FIXED_NOW,
    ...overrides,
    globalState,
  };
  return { deps, onUnauthorized, globalState };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

describe('isValidView', () => {
  it('accepts a well-formed view', () => {
    expect(isValidView(makeView())).toBe(true);
  });

  it('rejects corrupt shapes', () => {
    expect(isValidView(undefined)).toBe(false);
    expect(isValidView(null)).toBe(false);
    expect(isValidView({ plan: 'pro' })).toBe(false);
    expect(isValidView({ ...makeView(), plan: 'enterprise' })).toBe(false);
    expect(isValidView({ ...makeView(), valid_until: 'not-a-date' })).toBe(false);
    const missingKey = { ...makeView() };
    delete (missingKey.entitlements as Record<string, unknown>)['support.tier'];
    expect(isValidView(missingKey)).toBe(false);
    const wrongType = {
      ...makeView(),
      entitlements: { ...validEntitlements(), 'managed_models.enabled': { nested: true } },
    };
    expect(isValidView(wrongType)).toBe(false);
    const nullValue = {
      ...makeView(),
      entitlements: { ...validEntitlements(), 'managed_models.enabled': null },
    };
    expect(isValidView(nullValue)).toBe(false);
  });
});

describe('resolution order', () => {
  it('valid cache → no fetch, source fresh', async () => {
    const { fetchFn, calls } = makeFetch({ ok: true, status: 200, body: gatewayPayload() });
    const { deps, globalState } = makeDeps({ fetchFn });
    globalState.store.set(
      'sunday.entitlements.view',
      makeView(),
    );
    const cache = createEntitlementsCache(deps);
    const result = await cache.getEntitlements();
    expect(calls).toHaveLength(0);
    expect(result.source).toBe('fresh');
    expect(result.view.plan).toBe('pro');
    expect(result.view.user_id).toBe('user-1');
  });

  it('expired cache + fetch ok → fresh, stores the new view', async () => {
    const { fetchFn, calls } = makeFetch({ ok: true, status: 200, body: gatewayPayload('smart') });
    const { deps, globalState } = makeDeps({ fetchFn });
    globalState.store.set(
      'sunday.entitlements.view',
      makeView({ valid_until: new Date(FIXED_NOW - HOUR).toISOString() }),
    );
    const cache = createEntitlementsCache(deps);
    const result = await cache.getEntitlements();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('https://gw.test/me/entitlements');
    expect(result.source).toBe('fresh');
    expect(result.view.plan).toBe('smart');
    const stored = globalState.store.get('sunday.entitlements.view');
    expect(isValidView(stored)).toBe(true);
    expect((stored as EntitlementsView).plan).toBe('smart');
    expect(Date.parse((stored as EntitlementsView).valid_until)).toBeGreaterThan(FIXED_NOW);
  });

  it('fetch 401 → onUnauthorized called, falls back', async () => {
    const { fetchFn } = makeFetch({ ok: false, status: 401 });
    const { deps, onUnauthorized } = makeDeps({ fetchFn });
    const cache = createEntitlementsCache(deps);
    const result = await cache.getEntitlements();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('fallback');
    expect(result.view.entitlements['managed_models.enabled']).toBe(false);
  });

  it('fetch fails + within 72h grace → grace view returned', async () => {
    const { fetchFn } = makeFetch({ ok: false, status: 0, throws: new Error('network down') });
    const { deps, globalState } = makeDeps({ fetchFn });
    const expired = makeView({ valid_until: new Date(FIXED_NOW - 24 * HOUR).toISOString() });
    globalState.store.set('sunday.entitlements.view', expired);
    const cache = createEntitlementsCache(deps);
    const result = await cache.getEntitlements();
    expect(result.source).toBe('grace');
    expect(result.view).toEqual(expired);
    expect(result.view.plan).toBe('pro');
  });

  it('fetch fails + grace lapsed (beyond 72h) → fallback with managed disabled', async () => {
    const { fetchFn } = makeFetch({ ok: false, status: 503 });
    const { deps, globalState } = makeDeps({ fetchFn });
    globalState.store.set(
      'sunday.entitlements.view',
      makeView({ valid_until: new Date(FIXED_NOW - (ENTITLEMENTS_GRACE_WINDOW_MS + HOUR)).toISOString() }),
    );
    const cache = createEntitlementsCache(deps);
    const result = await cache.getEntitlements();
    expect(result.source).toBe('fallback');
    expect(result.view.entitlements['managed_models.enabled']).toBe(false);
    expect(result.view.entitlements['managed_models.daily_requests']).toBe(0);
    expect(result.view.entitlements['autocomplete.managed_route']).toBe(false);
    expect(result.view.plan).toBe('basic');
  });

  it('corrupt cache → treated as missing, fetch attempted', async () => {
    const { fetchFn, calls } = makeFetch({ ok: true, status: 200, body: gatewayPayload() });
    const { deps, globalState } = makeDeps({ fetchFn });
    globalState.store.set(
      'sunday.entitlements.view',
      { plan: 'pro', entitlements: { 'managed_models.enabled': true } }, // missing keys
    );
    const cache = createEntitlementsCache(deps);
    expect(cache.getCachedSync()).toBeUndefined();
    const result = await cache.getEntitlements();
    expect(calls).toHaveLength(1);
    expect(result.source).toBe('fresh');
  });

  it('signed out → signed-out view (same as fallback, user_id signed-out)', async () => {
    const { fetchFn, calls } = makeFetch({ ok: true, status: 200, body: gatewayPayload() });
    const { deps, globalState } = makeDeps({
      fetchFn,
      getSundaySession: async () => undefined,
    });
    const cache = createEntitlementsCache(deps);
    const result = await cache.getEntitlements();
    expect(result.source).toBe('signed-out');
    expect(result.view.user_id).toBe('signed-out');
    expect(calls).toHaveLength(0);
    expect(result.view).toEqual(signedOutView(() => FIXED_NOW));
  });

  it('never throws on network error', async () => {
    const { fetchFn } = makeFetch({ ok: false, status: 0, throws: new TypeError('fetch failed') });
    const { deps, globalState } = makeDeps({ fetchFn });
    const cache = createEntitlementsCache(deps);
    await expect(cache.getEntitlements()).resolves.toMatchObject({ source: 'fallback' });
  });

  it('never throws when getSundaySession throws', async () => {
    const { fetchFn, calls } = makeFetch({ ok: true, status: 200, body: gatewayPayload() });
    const { deps, globalState } = makeDeps({
      fetchFn,
      getSundaySession: async () => {
        throw new Error('boom');
      },
    });
    const cache = createEntitlementsCache(deps);
    const result = await cache.getEntitlements();
    expect(result.source).toBe('signed-out');
    expect(calls).toHaveLength(0);
  });
});

describe('cache maintenance', () => {
  it('getCachedSync returns the valid view synchronously, undefined otherwise', () => {
    const { deps, globalState } = makeDeps();
    const cache = createEntitlementsCache(deps);
    expect(cache.getCachedSync()).toBeUndefined();
    globalState.store.set('sunday.entitlements.view', makeView());
    expect(cache.getCachedSync()?.plan).toBe('pro');
  });

  it('clear() removes the cached view', async () => {
    const { deps, globalState } = makeDeps();
    globalState.store.set('sunday.entitlements.view', makeView());
    const cache = createEntitlementsCache(deps);
    cache.clear();
    await Promise.resolve();
    expect(cache.getCachedSync()).toBeUndefined();
  });

  it('notifySignedOut clears the cache', async () => {
    const { deps, globalState } = makeDeps();
    globalState.store.set('sunday.entitlements.view', makeView());
    const cache = createEntitlementsCache(deps);
    cache.notifySignedOut();
    await Promise.resolve();
    expect(cache.getCachedSync()).toBeUndefined();
  });

  it('refresh() forces a refetch even with a valid cache', async () => {
    const { fetchFn, calls } = makeFetch({ ok: true, status: 200, body: gatewayPayload('basic') });
    const { deps, globalState } = makeDeps({ fetchFn });
    globalState.store.set('sunday.entitlements.view', makeView());
    const cache = createEntitlementsCache(deps);
    const result = await cache.refresh();
    expect(calls).toHaveLength(1);
    expect(result.source).toBe('fresh');
    expect(result.view.plan).toBe('basic');
  });

  it('401 during refresh degrades to fallback without throwing', async () => {
    const { fetchFn } = makeFetch({ ok: false, status: 401 });
    const { deps, onUnauthorized } = makeDeps({ fetchFn });
    const cache = createEntitlementsCache(deps);
    const result = await cache.refresh();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('fallback');
  });

  it('grace boundary: exactly at 72h still grace', async () => {
    const { fetchFn } = makeFetch({ ok: false, status: 0, throws: new Error('down') });
    const { deps, globalState } = makeDeps({ fetchFn });
    globalState.store.set(
      'sunday.entitlements.view',
      makeView({ valid_until: new Date(FIXED_NOW - ENTITLEMENTS_GRACE_WINDOW_MS).toISOString() }),
    );
    const cache = createEntitlementsCache(deps);
    const result = await cache.getEntitlements();
    expect(result.source).toBe('grace');
  });

  it('fetch timeout constant is 10s', () => {
    expect(ENTITLEMENTS_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it('contract carries exactly 10 entitlement keys', () => {
    expect(ENTITLEMENT_KEYS).toHaveLength(10);
  });

  it('fallback has managed routes disabled', () => {
    const fb = fallbackEntitlements(() => FIXED_NOW);
    expect(fb.entitlements['managed_models.enabled']).toBe(false);
    expect(fb.entitlements['autocomplete.managed_route']).toBe(false);
    expect(fb.entitlements['managed_models.daily_requests']).toBe(0);
    expect(fb.plan).toBe('basic');
  });
});
