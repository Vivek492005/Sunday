// sunday-agent — hosted-gateway client for the Sunday Usage dashboard (D2).
//
// Thin, injectable transport for GET /me/usage. Everything that formats or
// validates data is pure and unit-tested here; the vscode shell (webview
// panel, SecretStorage, command registration) lives in usagePanel.ts.
//
// Session auth: the Sunday session JWT is owned by the sunday-google-auth
// extension. getSessionToken() reads it defensively — first the auth
// extension's exported API when present, then SecretStorage as a fallback —
// and returns undefined when the user is signed out. The dashboard then
// shows a "sign in required" state instead of failing.

/** Default gateway base URL (same default the auto-updater uses). */
export const DEFAULT_GATEWAY_URL = 'https://sunday-final-ide.onrender.com';

/** Extension id of the bundled Google auth provider (owns the session JWT). */
export const GOOGLE_AUTH_EXTENSION_ID = 'sunday.sunday-google-auth';

/** SecretStorage key some builds use to persist the Sunday session JWT. */
export const SESSION_TOKEN_SECRET_KEY = 'sunday.sessionToken';

/** Structural shape of `vscode.workspace.getConfiguration('sunday')`. */
export interface GatewayConfigSource {
  get<T>(key: string, def: T): T;
}

/**
 * Resolve the gateway base URL. Precedence: `sunday.gateway.url` setting,
 * then the SUNDAY_API_URL env var, then the built-in default.
 */
export function resolveGatewayUrl(
  cfg: GatewayConfigSource,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromCfg = cfg.get<string>('gateway.url', '').trim().replace(/\/+$/, '');
  if (fromCfg) return fromCfg;
  const fromEnv = (env.SUNDAY_API_URL ?? '').trim().replace(/\/+$/, '');
  return fromEnv || DEFAULT_GATEWAY_URL;
}

/** Dashboard payload (mirrors the gateway's UsageSnapshot). */
export interface UsageSnapshot {
  today: { requests: number; tokens_in: number; tokens_out: number };
  by_model: Array<{ model: string; requests: number; tokens: number }>;
  history_7d: Array<{ day: string; requests: number }>;
}

/** The gateway could not be reached (network error, DNS, timeout). */
export class GatewayUnreachableError extends Error {
  constructor(message = 'gateway unreachable') {
    super(message);
    this.name = 'GatewayUnreachableError';
  }
}

/** The session token was rejected or is missing (sign-in required). */
export class GatewayAuthError extends Error {
  constructor(message = 'authentication required') {
    super(message);
    this.name = 'GatewayAuthError';
  }
}

/** Minimal fetch shape (injectable for tests). */
export interface GatewayFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface GatewayFetch {
  (url: string, init?: GatewayFetchInit): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate the /me/usage payload — wire data is untrusted, so every field
 * is checked before the dashboard renders it. Returns undefined when the
 * shape is wrong (caller treats it as an error state, never renders raw).
 */
export function validateUsageSnapshot(raw: unknown): UsageSnapshot | undefined {
  if (!isRecord(raw)) return undefined;
  const { today, by_model, history_7d } = raw;
  if (!isRecord(today)) return undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  const requests = num(today.requests);
  const tokensIn = num(today.tokens_in);
  const tokensOut = num(today.tokens_out);
  if (requests === undefined || tokensIn === undefined || tokensOut === undefined) return undefined;
  if (!Array.isArray(by_model) || !Array.isArray(history_7d)) return undefined;
  const models: UsageSnapshot['by_model'] = [];
  for (const m of by_model) {
    if (!isRecord(m)) return undefined;
    const mr = num(m.requests);
    const mt = num(m.tokens);
    if (typeof m.model !== 'string' || mr === undefined || mt === undefined) return undefined;
    models.push({ model: m.model, requests: mr, tokens: mt });
  }
  const history: UsageSnapshot['history_7d'] = [];
  for (const h of history_7d) {
    if (!isRecord(h)) return undefined;
    const hr = num(h.requests);
    if (typeof h.day !== 'string' || hr === undefined) return undefined;
    history.push({ day: h.day, requests: hr });
  }
  return {
    today: { requests, tokens_in: tokensIn, tokens_out: tokensOut },
    by_model: models,
    history_7d: history,
  };
}

/**
 * GET /me/usage with a Sunday session token. Throws GatewayAuthError on
 * 401/403, GatewayUnreachableError on network failure, Error on malformed
 * payloads or other HTTP errors.
 */
export async function fetchUsageSnapshot(
  fetchImpl: GatewayFetch,
  gatewayUrl: string,
  sessionToken: string,
  streakDays?: number,
): Promise<UsageSnapshot> {
  if (!sessionToken) throw new GatewayAuthError('sign in to Sunday to see usage');
  const headers: Record<string, string> = { authorization: `Bearer ${sessionToken}` };
  // Streak bonus: tell the gateway our current streak so it can apply bonus quota.
  // Sanitized server-side; omitted when unknown (server treats as 0).
  if (typeof streakDays === 'number' && Number.isFinite(streakDays) && streakDays > 0) {
    headers['x-sunday-streak-days'] = String(Math.floor(streakDays));
  }
  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await fetchImpl(`${gatewayUrl}/me/usage`, { headers });
  } catch (err) {
    throw new GatewayUnreachableError(
      `could not reach the Sunday gateway: ${(err as Error).message}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new GatewayAuthError('Sunday session expired — sign in again to see usage');
  }
  if (!res.ok) {
    throw new Error(`usage request failed (HTTP ${res.status})`);
  }
  const snapshot = validateUsageSnapshot(await res.json());
  if (!snapshot) throw new Error('usage response had an unexpected shape');
  return snapshot;
}

/** Injectable seams for getSessionToken (vscode-free in tests). */
export interface SessionTokenDeps {
  /** Read another extension's exported API, or undefined when absent. */
  getExtensionExports: (id: string) => { getSundaySessionToken?: () => Promise<string | undefined> } | undefined;
  /** Read SecretStorage. */
  secretGet: (key: string) => Promise<string | undefined>;
}

/**
 * Resolve the Sunday session JWT for gateway calls. Tries the auth
 * extension's exported API first (it owns the token), then SecretStorage.
 * Returns undefined when signed out — callers show a sign-in prompt.
 * Never throws: every source is defensive.
 */
export async function getSessionToken(deps: SessionTokenDeps): Promise<string | undefined> {
  try {
    const api = deps.getExtensionExports(GOOGLE_AUTH_EXTENSION_ID);
    const fn = api?.getSundaySessionToken;
    if (typeof fn === 'function') {
      const t = await fn();
      if (typeof t === 'string' && t) return t;
    }
  } catch {
    /* fall through to SecretStorage */
  }
  try {
    const t = await deps.secretGet(SESSION_TOKEN_SECRET_KEY);
    if (typeof t === 'string' && t) return t;
  } catch {
    /* signed out */
  }
  return undefined;
}
