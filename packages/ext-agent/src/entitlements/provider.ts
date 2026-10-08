// sunday-agent — entitlements provider seam (Task 7: Gated touchpoints).
//
// Task 6 implements the real `EntitlementsProvider` in
// `entitlementsCache.ts` and calls `setEntitlementsProvider()` at
// activation. Gated features (model picker, orchestration caps, browser
// agent toggle, index cap) consume it ONLY through this seam — they never
// import the cache directly.
//
// Until the provider is registered (or when a read fails), every gate
// FAILS OPEN: the feature is allowed and the hosted gateway enforces the
// real limits server-side. A gate must NEVER hard-crash the extension.

import type { EntitlementsProvider, EntitlementsView } from './types.js';

/** The active provider — set once by `setEntitlementsProvider()` at activation. */
export let provider: EntitlementsProvider | undefined;

/** Register the active entitlements provider (called once at activation). */
export function setEntitlementsProvider(p: EntitlementsProvider): void {
  provider = p;
}

/**
 * The active provider. Throws a clear error when it was never registered
 * (Task 6 not wired yet) — callers that want fail-open behaviour should use
 * `getProviderOrUndefined()`, `getEntitlementsView()` or `getCachedView()`.
 */
export function getProvider(): EntitlementsProvider {
  if (!provider) {
    throw new Error(
      'entitlements provider is not set — call setEntitlementsProvider() at activation before using gated features',
    );
  }
  return provider;
}

/** The active provider, or undefined when not registered yet. Never throws. */
export function getProviderOrUndefined(): EntitlementsProvider | undefined {
  return provider;
}

/** Test-only: unregister the provider (lets tests start from a clean slate). */
export function resetEntitlementsProviderForTests(): void {
  provider = undefined;
}

/**
 * Fail-open entitlements read for gated features. Returns the view, or
 * undefined when the provider is unset or the read throws — callers treat
 * "undefined" as "entitlements unknown, allow the feature" because the
 * hosted gateway re-checks entitlements server-side on every managed
 * request.
 */
export async function getEntitlementsView(
  log?: (msg: string) => void,
): Promise<EntitlementsView | undefined> {
  try {
    const p = getProviderOrUndefined();
    if (!p) return undefined;
    const { view } = await p.getEntitlements();
    return view;
  } catch (err) {
    log?.(`entitlements: read failed, failing open: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Synchronous fail-open read of the last-known cached view (undefined when
 * never fetched). For sync UI paths — e.g. sidecar spawn env and webview
 * state refreshes.
 */
export function getCachedView(log?: (msg: string) => void): EntitlementsView | undefined {
  try {
    return getProviderOrUndefined()?.getCachedSync();
  } catch (err) {
    log?.(`entitlements: cached read failed, failing open: ${(err as Error).message}`);
    return undefined;
  }
}
