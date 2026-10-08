// sunday-agent — entitlements cache (Task 6).
//
// Client-side cache for GET /me/entitlements with a 72h grace window.
// Implements the `EntitlementsProvider` contract in types.ts (the file Task 7
// consumes). Resolution order, exactly:
//
//   1. valid cache (valid_until in future)          → { view, source: 'fresh' } (no network)
//   2. else try fetch                              → success → store + { view, source: 'fresh' }
//   3. fetch fails + expired cache within 72h grace → { view: cached, source: 'grace' }
//   4. grace lapsed or no cache                    → { view: fallbackEntitlements(), source: 'fallback' }
//   5. no Sunday session                           → { view: signedOutView(), source: 'signed-out' }
//
// NEVER throws on network errors. Security: never log tokens or full views.
// The gateway re-checks entitlements server-side on every managed request, so
// a stale or tampered cache can only hide UI, never bypass limits.
import type {
  EntitlementKey,
  Entitlements,
  EntitlementsProvider,
  EntitlementsResult,
  EntitlementsSource,
  EntitlementsView,
  EntitlementValue,
  PlanId,
} from './types.js';

/** globalState key holding the full EntitlementsView. */
export const ENTITLEMENTS_STORAGE_KEY = 'sunday.entitlements.view';
/** Grace window after valid_until during which an expired cache is still served. */
export const ENTITLEMENTS_GRACE_WINDOW_MS = 72 * 60 * 60 * 1000;
/** How long a freshly fetched view stays valid without a network call. */
export const ENTITLEMENTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Gateway fetch timeout. */
export const ENTITLEMENTS_FETCH_TIMEOUT_MS = 10_000;
/** Baked-in default when no gateway URL is configured. */
export const DEFAULT_GATEWAY_URL = 'https://sunday-final-ide.onrender.com';

/** All 10 entitlement keys, in contract order. */
export const ENTITLEMENT_KEYS: readonly EntitlementKey[] = [
  'managed_models.enabled',
  'managed_models.daily_requests',
  'orchestration.max_feature_agents',
  'orchestration.parallel',
  'browser_agent.enabled',
  'browser_agent.daily_sessions',
  'codebase_index.max_repo_mb',
  'autocomplete.managed_route',
  'scheduler.priority_class',
  'support.tier',
];

const PLANS: readonly PlanId[] = ['basic', 'smart', 'pro'];
const STATUSES: readonly EntitlementsView['status'][] = [
  'active',
  'past_due',
  'cancelling',
  'cancelled',
];

/** Minimal surface of vscode.Memento — globalState passed in, mockable in tests. */
export interface EntitlementsGlobalState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** Shape of the auth extension's exported getSundaySession() result. */
export interface SundaySessionLike {
  sessionToken: string;
  user?: { id?: string };
}

/** Minimal fetch surface this module needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface EntitlementsCacheDeps {
  /** VS Code ExtensionContext.globalState (only this slice is used). */
  globalState: EntitlementsGlobalState;
  /** Resolves the current Sunday session JWT (from sunday-google-auth). */
  getSundaySession: () => Promise<SundaySessionLike | undefined>;
  /** fetch implementation; defaults to the global fetch. */
  fetchFn?: FetchLike;
  /** Gateway base URL (no trailing slash); defaults to DEFAULT_GATEWAY_URL. */
  gatewayUrl?: string;
  /**
   * Called on HTTP 401 from /me/entitlements so the host can clear session
   * state (e.g. sign out). Errors are swallowed; cache keeps its grace path.
   */
  onUnauthorized?: () => void | Promise<void>;
  log?: (msg: string) => void;
  /** Clock override (tests). */
  now?: () => number;
}

function isEntitlementValue(v: unknown): v is EntitlementValue {
  const t = typeof v;
  return t === 'boolean' || t === 'number' || t === 'string';
}

function isValidEntitlements(v: unknown): v is Entitlements {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return ENTITLEMENT_KEYS.every((k) => isEntitlementValue(rec[k]));
}

/**
 * Shape-check a stored/fetched EntitlementsView. Corrupt data → false
 * (callers treat it as missing).
 */
export function isValidView(v: unknown): v is EntitlementsView {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.user_id !== 'string') return false;
  if (!PLANS.includes(o.plan as PlanId)) return false;
  if (!STATUSES.includes(o.status as EntitlementsView['status'])) return false;
  if (!(o.renews_at === null || typeof o.renews_at === 'string')) return false;
  if (!isValidEntitlements(o.entitlements)) return false;
  if (typeof o.cached_at !== 'string' || Number.isNaN(Date.parse(o.cached_at))) return false;
  if (typeof o.valid_until !== 'string' || Number.isNaN(Date.parse(o.valid_until))) return false;
  return true;
}

/** The /me/entitlements response body: { plan, entitlements }. */
function isEntitlementsPayload(v: unknown): v is { plan: PlanId; entitlements: Entitlements } {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return PLANS.includes(o.plan as PlanId) && isValidEntitlements(o.entitlements);
}

const nowIso = (now: () => number): string => new Date(now()).toISOString();

/**
 * Fallback view: Basic-equivalent with managed routes disabled. Used when the
 * gateway is unreachable and the grace window has lapsed.
 */
export function fallbackEntitlements(now: () => number = Date.now): EntitlementsView {
  const ts = nowIso(now);
  return {
    user_id: 'unknown',
    plan: 'basic',
    status: 'active',
    renews_at: null,
    entitlements: {
      'managed_models.enabled': false,
      'managed_models.daily_requests': 0,
      'orchestration.max_feature_agents': 1,
      'orchestration.parallel': false,
      'browser_agent.enabled': false,
      'browser_agent.daily_sessions': 0,
      'codebase_index.max_repo_mb': 100,
      'autocomplete.managed_route': false,
      'scheduler.priority_class': 'standard',
      'support.tier': 'community',
    },
    cached_at: ts,
    valid_until: ts,
  };
}

/** Same as the fallback view, but tagged for a signed-out user. */
export function signedOutView(now: () => number = Date.now): EntitlementsView {
  return { ...fallbackEntitlements(now), user_id: 'signed-out' };
}

export class EntitlementsCache implements EntitlementsProvider {
  private readonly deps: EntitlementsCacheDeps;

  constructor(deps: EntitlementsCacheDeps) {
    this.deps = deps;
  }

  private get now(): () => number {
    return this.deps.now ?? Date.now;
  }

  private get gatewayUrl(): string {
    return (this.deps.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
  }

  private get fetchFn(): FetchLike {
    if (this.deps.fetchFn) return this.deps.fetchFn;
    return ((url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) =>
      fetch(url, init) as unknown as Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>);
  }

  private log(msg: string): void {
    this.deps.log?.(`[entitlements] ${msg}`);
  }

  /** Synchronous read of the last-known VALID view (undefined when never fetched / corrupt). */
  getCachedSync(): EntitlementsView | undefined {
    try {
      const raw = this.deps.globalState.get<unknown>(ENTITLEMENTS_STORAGE_KEY);
      return isValidView(raw) ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  private async store(view: EntitlementsView): Promise<void> {
    try {
      await this.deps.globalState.update(ENTITLEMENTS_STORAGE_KEY, view);
    } catch (err) {
      this.log(`cache store failed: ${(err as Error).message}`);
    }
  }

  private async getSession(): Promise<SundaySessionLike | undefined> {
    try {
      return (await this.deps.getSundaySession()) ?? undefined;
    } catch (err) {
      this.log(`getSundaySession failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Fetch /me/entitlements with a 10s timeout. Returns a validated
   * EntitlementsView on success, or undefined on any failure. On 401 the
   * onUnauthorized callback is invoked (errors swallowed).
   */
  private async fetchView(session: SundaySessionLike): Promise<EntitlementsView | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENTITLEMENTS_FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(`${this.gatewayUrl}/me/entitlements`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        signal: controller.signal,
      });
      if (res.status === 401) {
        try {
          await this.deps.onUnauthorized?.();
        } catch (err) {
          this.log(`onUnauthorized failed: ${(err as Error).message}`);
        }
        return undefined;
      }
      if (!res.ok) {
        this.log(`fetch failed (HTTP ${res.status})`);
        return undefined;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        this.log('fetch failed: invalid JSON');
        return undefined;
      }
      if (!isEntitlementsPayload(body)) {
        this.log('fetch failed: unexpected response shape');
        return undefined;
      }
      const now = this.now();
      return {
        user_id: session.user?.id ?? 'unknown',
        plan: body.plan,
        status: 'active',
        renews_at: null,
        entitlements: body.entitlements,
        cached_at: new Date(now).toISOString(),
        valid_until: new Date(now + ENTITLEMENTS_CACHE_TTL_MS).toISOString(),
      };
    } catch (err) {
      // Network error, timeout (abort), DNS — never throw; degrade instead.
      this.log(`fetch failed: ${(err as Error)?.name ?? 'error'}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve in the documented order. NEVER throws for network problems —
   * degrades to grace/fallback instead.
   */
  async getEntitlements(): Promise<EntitlementsResult> {
    try {
      const session = await this.getSession();
      if (!session?.sessionToken) {
        return { view: signedOutView(this.now), source: 'signed-out' };
      }

      const cached = this.getCachedSync();
      const now = this.now();
      if (cached && Date.parse(cached.valid_until) > now) {
        return { view: cached, source: 'fresh' };
      }

      const fetched = await this.fetchView(session);
      if (fetched) {
        await this.store(fetched);
        return { view: fetched, source: 'fresh' };
      }

      if (cached && now - Date.parse(cached.valid_until) <= ENTITLEMENTS_GRACE_WINDOW_MS) {
        return { view: cached, source: 'grace' };
      }
      return { view: fallbackEntitlements(this.now), source: 'fallback' };
    } catch (err) {
      // Absolute last resort — getEntitlements never throws.
      this.log(`resolve failed: ${(err as Error).message}`);
      return { view: fallbackEntitlements(this.now), source: 'fallback' };
    }
  }

  /** Force a refetch from the gateway (used by the refresh command). */
  async refresh(): Promise<EntitlementsResult> {
    try {
      const session = await this.getSession();
      if (!session?.sessionToken) {
        return { view: signedOutView(this.now), source: 'signed-out' };
      }
      const fetched = await this.fetchView(session);
      if (fetched) {
        await this.store(fetched);
        return { view: fetched, source: 'fresh' };
      }
      const cached = this.getCachedSync();
      const now = this.now();
      if (cached && now - Date.parse(cached.valid_until) <= ENTITLEMENTS_GRACE_WINDOW_MS) {
        return { view: cached, source: 'grace' };
      }
      return { view: fallbackEntitlements(this.now), source: 'fallback' };
    } catch (err) {
      this.log(`refresh failed: ${(err as Error).message}`);
      return { view: fallbackEntitlements(this.now), source: 'fallback' };
    }
  }

  /** Clear cached state (called on sign-out). */
  clear(): void {
    try {
      // Thenable has no .catch — wrap so rejections are logged, never thrown.
      void Promise.resolve(this.deps.globalState.update(ENTITLEMENTS_STORAGE_KEY, undefined)).catch(
        (err: Error) => {
          this.log(`clear failed: ${err.message}`);
        },
      );
    } catch (err) {
      this.log(`clear failed: ${(err as Error).message}`);
    }
  }

  /** Called by the auth flow after sign-in: refresh entitlements (fire-and-forget). */
  notifySignedIn(): void {
    void this.refresh();
  }

  /** Called by the auth flow after sign-out: drop the cached view. */
  notifySignedOut(): void {
    this.clear();
  }
}

/** Factory used by extension.ts (kept thin; all logic lives in the class). */
export function createEntitlementsCache(deps: EntitlementsCacheDeps): EntitlementsCache {
  return new EntitlementsCache(deps);
}

export function sourceLabel(source: EntitlementsSource): string {
  switch (source) {
    case 'fresh':
      return 'up to date';
    case 'cache':
      return 'cached';
    case 'grace':
      return 'offline grace period';
    case 'fallback':
      return 'offline defaults';
    case 'signed-out':
      return 'signed out';
  }
}
