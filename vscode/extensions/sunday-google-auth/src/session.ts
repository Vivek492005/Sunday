/**
 * Sunday hosted-gateway session management (Phase 9.a).
 *
 * Layers a Sunday gateway session on top of the Google AuthenticationProvider
 * in `extension.ts`. Google sign-in remains the source of truth; the gateway
 * session is best-effort and local-first:
 *
 * - After Google sign-in, the Google access token is exchanged at
 *   POST {gateway}/auth/session for a short-lived Sunday session JWT plus a
 *   long-lived refresh token (both kept in SecretStorage).
 * - `getSundaySession()` returns the stored session while its JWT is fresh
 *   (>60s of life left), transparently refreshing it via POST /auth/refresh
 *   when expired.
 * - Sign-out does a best-effort POST /auth/logout and clears all Sunday
 *   secrets.
 *
 * This module is intentionally free of the `vscode` API so the pure logic
 * (JWT decoding, request building, refresh decisions) is unit-testable with
 * injected `fetch` and storage fakes. See `session.test.ts`.
 */

// -- Gateway URL ----------------------------------------------------------------

export const DEFAULT_GATEWAY_URL = 'https://sunday-final-ide.onrender.com';

/**
 * Resolve the gateway base URL. Precedence: `SUNDAY_GATEWAY_URL` env var,
 * then the `sunday.account.gatewayUrl` setting, then the baked-in default.
 */
export function resolveGatewayUrl(opts?: {
  envUrl?: string;
  settingUrl?: string;
}): string {
  const normalize = (u: string): string => u.trim().replace(/\/+$/, '');
  const env = opts?.envUrl ? normalize(opts.envUrl) : '';
  if (env) {
    return env;
  }
  const setting = opts?.settingUrl ? normalize(opts.settingUrl) : '';
  if (setting) {
    return setting;
  }
  return DEFAULT_GATEWAY_URL;
}

// -- JWT helpers ------------------------------------------------------------------

/** Decode the `exp` (seconds since epoch) claim of a JWT without verification. */
export function decodeJwtExp(jwt: string): number | undefined {
  const parts = jwt.split('.');
  if (parts.length < 2 || !parts[1]) {
    return undefined;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp
      : undefined;
  } catch {
    return undefined;
  }
}

/** Freshness threshold: a session JWT is usable only if >60s of life remains. */
export const SUNDAY_JWT_FRESHNESS_SKEW_MS = 60_000;

export function isJwtFresh(
  jwt: string,
  nowMs: number = Date.now(),
  skewMs: number = SUNDAY_JWT_FRESHNESS_SKEW_MS,
): boolean {
  const exp = decodeJwtExp(jwt);
  if (exp === undefined) {
    return false;
  }
  return exp * 1000 - nowMs > skewMs;
}

// -- HTTP ---------------------------------------------------------------------------

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type HttpFetch = (
  url: string,
  init: HttpRequestInit,
) => Promise<HttpResponse>;

/** Adapt the global fetch to the minimal structural interface above. */
export const nodeFetch: HttpFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<HttpResponse>;

export class GatewayError extends Error {
  /** HTTP status when the gateway answered; undefined for network errors. */
  readonly status?: number;
  constructor(message: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GatewayError';
    this.status = status;
  }
  get isNetworkError(): boolean {
    return this.status === undefined;
  }
}

export const GATEWAY_TIMEOUT_MS = 10_000;

async function postJson(
  fetchImpl: HttpFetch,
  url: string,
  body: unknown,
  timeoutMs: number = GATEWAY_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new GatewayError(
        `Sunday gateway request failed (HTTP ${res.status})`,
        res.status,
      );
    }
    return await res.json();
  } catch (e) {
    if (e instanceof GatewayError) {
      throw e;
    }
    const reason =
      e instanceof Error && e.name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : e instanceof Error
          ? e.message
          : String(e);
    throw new GatewayError(`Sunday gateway unreachable (${reason})`, undefined, e);
  } finally {
    clearTimeout(timer);
  }
}

// -- Gateway API ----------------------------------------------------------------------

export interface SundayUser {
  id: string;
  email?: string;
  display_name?: string;
  avatar_url?: string;
}

export interface SessionPair {
  sessionToken: string;
  refreshToken: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Sunday gateway: malformed response (missing ${field})`);
  }
  return value;
}

/** POST {gw}/auth/session — exchange a Google access token for a Sunday session. */
export async function exchangeGoogleToken(
  fetchImpl: HttpFetch,
  gatewayUrl: string,
  googleAccessToken: string,
  timeoutMs: number = GATEWAY_TIMEOUT_MS,
): Promise<{ sessionToken: string; refreshToken: string; user: SundayUser }> {
  const body = (await postJson(
    fetchImpl,
    `${gatewayUrl}/auth/session`,
    { google_access_token: googleAccessToken },
    timeoutMs,
  )) as Record<string, unknown>;
  const user = (body.user ?? {}) as Record<string, unknown>;
  return {
    sessionToken: requireString(body.session_token, 'session_token'),
    refreshToken: requireString(body.refresh_token, 'refresh_token'),
    user: {
      id: typeof user.id === 'string' ? user.id : '',
      email: typeof user.email === 'string' ? user.email : undefined,
      display_name:
        typeof user.display_name === 'string' ? user.display_name : undefined,
      avatar_url: typeof user.avatar_url === 'string' ? user.avatar_url : undefined,
    },
  };
}

/** POST {gw}/auth/refresh — rotate the session JWT using the refresh token. */
export async function refreshSundaySession(
  fetchImpl: HttpFetch,
  gatewayUrl: string,
  refreshToken: string,
  timeoutMs: number = GATEWAY_TIMEOUT_MS,
): Promise<SessionPair> {
  const body = (await postJson(
    fetchImpl,
    `${gatewayUrl}/auth/refresh`,
    { refresh_token: refreshToken },
    timeoutMs,
  )) as Record<string, unknown>;
  return {
    sessionToken: requireString(body.session_token, 'session_token'),
    refreshToken: requireString(body.refresh_token, 'refresh_token'),
  };
}

/** POST {gw}/auth/logout — best-effort; never throws (idempotent server-side). */
export async function logoutSundaySession(
  fetchImpl: HttpFetch,
  gatewayUrl: string,
  refreshToken: string,
  timeoutMs: number = GATEWAY_TIMEOUT_MS,
): Promise<void> {
  try {
    await postJson(
      fetchImpl,
      `${gatewayUrl}/auth/logout`,
      { refresh_token: refreshToken },
      timeoutMs,
    );
  } catch {
    // Best-effort: the gateway treats logout as idempotent, and local
    // secrets are cleared regardless.
  }
}

// -- Secret storage ---------------------------------------------------------------------

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const SECRET_SESSION_TOKEN = 'sunday.sessionToken';
export const SECRET_REFRESH_TOKEN = 'sunday.refreshToken';
export const SECRET_USER = 'sunday.user';

export interface SundaySession {
  sessionToken: string;
  user: SundayUser;
}

function parseUser(raw: string | undefined): SundayUser {
  if (!raw) {
    return { id: '' };
  }
  try {
    const parsed = JSON.parse(raw) as SundayUser;
    return typeof parsed?.id === 'string' ? parsed : { id: '' };
  } catch {
    return { id: '' };
  }
}

/**
 * Owns the Sunday session lifecycle in SecretStorage. All gateway failures
 * are contained here: `establish()` never throws, and `getSundaySession()`
 * returns `undefined` when no usable session exists so callers can fall back
 * to Google-only mode.
 */
export class SundaySessionManager {
  constructor(
    private readonly storage: SecretStore,
    private readonly gatewayUrl: string,
    private readonly onChanged?: () => void,
    private readonly fetchImpl: HttpFetch = nodeFetch,
    private readonly timeoutMs: number = GATEWAY_TIMEOUT_MS,
  ) {}

  private emitChanged(): void {
    try {
      this.onChanged?.();
    } catch {
      // Session-change listeners must never break the auth flow.
    }
  }

  /**
   * Establish a Sunday session from a fresh Google access token. Best-effort:
   * logs out any previous Sunday refresh token first, then exchanges. Never
   * throws — on any gateway failure the Sunday secrets are left empty so the
   * caller continues in Google-only mode.
   */
  async establish(
    googleAccessToken: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const previousRefresh = await this.storage
      .get(SECRET_REFRESH_TOKEN)
      .catch(() => undefined);
    if (previousRefresh) {
      await logoutSundaySession(
        this.fetchImpl,
        this.gatewayUrl,
        previousRefresh,
        this.timeoutMs,
      );
    }
    await this.clear(false);
    try {
      const result = await exchangeGoogleToken(
        this.fetchImpl,
        this.gatewayUrl,
        googleAccessToken,
        this.timeoutMs,
      );
      await this.storage.store(SECRET_SESSION_TOKEN, result.sessionToken);
      await this.storage.store(SECRET_REFRESH_TOKEN, result.refreshToken);
      await this.storage.store(SECRET_USER, JSON.stringify(result.user));
    } catch (e) {
      await this.clear(false);
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason };
    }
    this.emitChanged();
    return { ok: true };
  }

  /**
   * Return the current Sunday session, refreshing the JWT first when it is
   * expired (or malformed). Returns `undefined` when there is no session, the
   * refresh token is rejected (401 → tokens cleared), or the gateway cannot
   * be reached.
   */
  async getSundaySession(): Promise<SundaySession | undefined> {
    const [sessionToken, refreshToken, userRaw] = await Promise.all([
      this.storage.get(SECRET_SESSION_TOKEN).catch(() => undefined),
      this.storage.get(SECRET_REFRESH_TOKEN).catch(() => undefined),
      this.storage.get(SECRET_USER).catch(() => undefined),
    ]);
    if (!sessionToken) {
      return undefined;
    }
    if (isJwtFresh(sessionToken)) {
      return { sessionToken, user: parseUser(userRaw) };
    }
    if (!refreshToken) {
      await this.clear();
      return undefined;
    }
    try {
      const pair = await refreshSundaySession(
        this.fetchImpl,
        this.gatewayUrl,
        refreshToken,
        this.timeoutMs,
      );
      await this.storage.store(SECRET_SESSION_TOKEN, pair.sessionToken);
      await this.storage.store(SECRET_REFRESH_TOKEN, pair.refreshToken);
      this.emitChanged();
      return { sessionToken: pair.sessionToken, user: parseUser(userRaw) };
    } catch (e) {
      if (e instanceof GatewayError && e.status === 401) {
        // Refresh token invalid/expired/replayed — drop the Sunday session.
        await this.clear();
        return undefined;
      }
      // Transient network failure: keep the stored tokens so a later retry
      // can still refresh; report no usable session for now.
      return undefined;
    }
  }

  /**
   * Sign out of the Sunday gateway: best-effort server logout, then delete
   * all Sunday secrets. Never throws.
   */
  async signOut(): Promise<void> {
    const refreshToken = await this.storage
      .get(SECRET_REFRESH_TOKEN)
      .catch(() => undefined);
    if (refreshToken) {
      await logoutSundaySession(
        this.fetchImpl,
        this.gatewayUrl,
        refreshToken,
        this.timeoutMs,
      );
    }
    await this.clear();
  }

  /** Delete all Sunday secrets from storage. */
  async clear(emit: boolean = true): Promise<void> {
    await Promise.all([
      this.storage.delete(SECRET_SESSION_TOKEN).catch(() => undefined),
      this.storage.delete(SECRET_REFRESH_TOKEN).catch(() => undefined),
      this.storage.delete(SECRET_USER).catch(() => undefined),
    ]);
    if (emit) {
      this.emitChanged();
    }
  }
}
