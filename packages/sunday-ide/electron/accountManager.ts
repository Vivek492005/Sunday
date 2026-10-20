/**
 * Sunday IDE — accountManager.ts
 *
 * SIGN-IN / ACCOUNT: Google OAuth 2.0 loopback flow (RFC 8252 §7.3) ported
 * faithfully from vscode/extensions/sunday-google-auth/src/extension.ts,
 * layered with the hosted-gateway Sunday session from that extension's
 * vscode-free session.ts (imported directly — same precedent as
 * agentBackend.ts importing ../../ext-agent/src/*.js).
 *
 * Differences from the VS Code version, by design:
 * - `vscode.env.openExternal` is replaced by an injected `openUrl` dep
 *   (main.ts passes `shell.openExternal`).
 * - `vscode.env.machineId` is replaced by `machineId()` below (stable
 *   sha256 of hostname|homedir|platform).
 * - Secrets live in `~/.sunday-ide/session.json` (0600, atomic tmp+rename)
 *   instead of VS Code SecretStorage, because this is the standalone IDE.
 *
 * SECURITY: no token value is ever logged or embedded in an error string.
 * The loopback server binds 127.0.0.1 only and validates `state`.
 */
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { URL, URLSearchParams } from 'node:url';

// NOTE on the relative path: the task brief said `../../vscode/...`, but
// from packages/sunday-ide/electron/ the repo-root vscode/ tree is three
// levels up (`packages/vscode` does not exist). This is the correct path.
import {
  exchangeGoogleToken,
  refreshSundaySession,
  logoutSundaySession,
  isJwtFresh,
  decodeJwtExp,
  resolveGatewayUrl,
  GatewayError,
  nodeFetch,
  type HttpFetch,
  type SundayUser,
} from '../../../vscode/extensions/sunday-google-auth/src/session.js';

import { daemonRpc } from './daemonClient.js';

export { decodeJwtExp, GatewayError };
export type { SundayUser };

// ---------------------------------------------------------------------------
// Constants (from extension.ts — Desktop-app OAuth client, no client_secret)
// ---------------------------------------------------------------------------

export const GOOGLE_CLIENT_ID =
  '110112861017-vceq10n514dajcj2hakr1mulk2feop6t.apps.googleusercontent.com';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = ['openid', 'email', 'profile'].join(' ');

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const GATEWAY_TIMEOUT_MS = 10_000;
const GOOGLE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Shared shapes (mirror these in electron/preload.ts + src/services/accountService.ts)
// ---------------------------------------------------------------------------

export interface AccountUserOut {
  id: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface AccountStatusOut {
  signedIn: boolean;
  user?: AccountUserOut;
  /** Plan id from GET /me/entitlements (`basic` | `smart` | `pro`) when known. */
  plan?: string;
  /**
   * Staleness honesty flag: `true` means the stored session could not be
   * refreshed because the gateway was unreachable (network error), so the
   * UI is showing the last known account. The tokens are kept on disk so a
   * later call can still refresh. Never set on a 401 (that clears the file).
   */
  stale?: boolean;
  /** Human-readable, token-free error message (sign-in failures). */
  error?: string;
}

export interface QuotaOut {
  requestsUsed: number;
  tokensIn: number;
  tokensOut: number;
  baseQuota: number;
  totalQuota: number;
  quotaRemaining: number;
}

export type QuotaResult = QuotaOut | { error: string };

/** On-disk session file shape (`~/.sunday-ide/session.json`, mode 0600). */
export interface StoredSession {
  session_token: string;
  refresh_token: string;
  user: SundayUser;
  google_refresh_token?: string;
  google_access_token?: string;
  plan?: string;
  updated_at: string;
}

export interface AccountManagerDeps {
  /** Override for os.homedir() — used by tests with a temp HOME. */
  homeDir?: string;
  /** Injected fetch (session.ts HttpFetch shape). Defaults to nodeFetch. */
  fetchImpl?: HttpFetch;
  /** Gateway base URL override. Defaults to SUNDAY_GATEWAY_URL env / hosted default. */
  gatewayUrl?: string;
  googleClientId?: string;
  /** Opens the Google consent URL (main.ts: shell.openExternal). */
  openUrl?: (url: string) => Promise<void>;
  /** Best-effort daemon configure with the Sunday session token. */
  daemonConfigure?: (token: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// machineId
// ---------------------------------------------------------------------------

/**
 * Stable per-machine id for the gateway's account-switch anti-abuse limit
 * (max 2 Google accounts per machine per 24h). sha256 hex of
 * `${hostname}|${homedir}|${platform}` — no raw identifiers leave the box.
 */
export function machineId(homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  return crypto
    .createHash('sha256')
    .update(`${os.hostname()}|${home}|${os.platform()}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Session persistence — loaders NEVER throw, tokens NEVER logged
// ---------------------------------------------------------------------------

export function sessionDir(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.sunday-ide');
}

export function sessionFilePath(homeDir?: string): string {
  return path.join(sessionDir(homeDir), 'session.json');
}

export function loadStoredSession(homeDir?: string): StoredSession | null {
  try {
    const raw = fs.readFileSync(sessionFilePath(homeDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.session_token !== 'string' ||
      !parsed.session_token ||
      typeof parsed.refresh_token !== 'string' ||
      !parsed.refresh_token ||
      typeof parsed.user !== 'object' ||
      parsed.user === null
    ) {
      return null;
    }
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

export function saveStoredSession(session: StoredSession, homeDir?: string): void {
  const dir = sessionDir(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Pre-existing dir with different mode — best effort only.
  }
  const file = sessionFilePath(homeDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // mode was set at write time; rename keeps it on POSIX.
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows / exotic fs — file contents stay protected by the dir ACL.
  }
}

export function deleteStoredSession(homeDir?: string): void {
  try {
    fs.unlinkSync(sessionFilePath(homeDir));
  } catch {
    // Already gone — sign-out is idempotent.
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function gatewayFor(deps: AccountManagerDeps): string {
  if (deps.gatewayUrl) return deps.gatewayUrl.replace(/\/+$/, '');
  return resolveGatewayUrl({ envUrl: process.env.SUNDAY_GATEWAY_URL });
}

function fetchFor(deps: AccountManagerDeps): HttpFetch {
  return deps.fetchImpl ?? nodeFetch;
}

function toUserOut(user: SundayUser): AccountUserOut {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
  };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Best-effort daemon configure — errors are swallowed by design.
 * Guarded by the last-configured token so status polls don't spam the
 * daemon with identical configure RPCs, while a NEW daemon process
 * (IDE restart) still gets the token on the first status check even
 * when the stored JWT is still fresh.
 */
let lastDaemonConfiguredToken: string | null = null;

async function tryDaemonConfigure(
  deps: AccountManagerDeps,
  token: string,
): Promise<void> {
  if (!deps.daemonConfigure) return;
  if (token === lastDaemonConfiguredToken) return;
  try {
    await deps.daemonConfigure(token);
    lastDaemonConfiguredToken = token;
  } catch {
    // Sign-in/out must succeed even when the daemon is down.
  }
}

/**
 * Push the Sunday session token to the sundayd daemon via daemon/configure.
 * Exported for main.ts wiring (deps.daemonConfigure).
 *
 * CLEARING LIMITATION (honest): when `token` is empty this calls
 * daemon/configure WITHOUT `sundayApiToken` — the protocol schema requires
 * min(1) for that field, and packages/sundayd/src/daemon.ts only assigns
 * `process.env.SUNDAY_API_TOKEN` when the value is truthy. So an empty-token
 * configure does NOT unset the token inside an already-running daemon; the
 * daemon keeps the old in-memory token until it restarts. Local sign-out
 * (session file deletion + gateway logout + Google revoke) is unaffected.
 */
export async function configureDaemonWithSession(
  workspaceRoot: string,
  token: string,
): Promise<void> {
  if (token) {
    await daemonRpc('daemon/configure', { workspaceRoot, sundayApiToken: token });
  } else {
    await daemonRpc('daemon/configure', { workspaceRoot });
  }
}

/** GET /me/entitlements → plan id (`basic`|`smart`|`pro`), best-effort. */
async function fetchPlan(
  fetchImpl: HttpFetch,
  gatewayUrl: string,
  sessionToken: string,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${gatewayUrl}/me/entitlements`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${sessionToken}` },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.plan === 'string' && body.plan) return body.plan;
    const nested = body.entitlements as Record<string, unknown> | undefined;
    // /auth/session nests the view as { entitlements: { plan, ... } } in
    // some shapes — accept a nested plan too, defensively.
    if (nested && typeof nested.plan === 'string' && nested.plan) return nested.plan;
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

type EnsureResult =
  | { status: 'ok'; session: StoredSession; stale: boolean }
  | { status: 'signed-out' }
  | { status: 'expired' };

/**
 * Load the stored session and refresh it when the JWT is not fresh.
 * - fresh JWT          → ok, no network
 * - refresh success    → rotated pair saved, ok
 * - refresh 401        → file deleted, expired
 * - network/other error → ok with stale=true and the OLD session (kept on disk)
 */
async function ensureFreshSession(deps: AccountManagerDeps): Promise<EnsureResult> {
  const stored = loadStoredSession(deps.homeDir);
  if (!stored) return { status: 'signed-out' };
  if (isJwtFresh(stored.session_token)) {
    // Fresh token, no network needed — but a freshly started daemon
    // process has not been configured with it yet (IDE restart case).
    await tryDaemonConfigure(deps, stored.session_token);
    return { status: 'ok', session: stored, stale: false };
  }
  if (!stored.refresh_token) {
    deleteStoredSession(deps.homeDir);
    return { status: 'expired' };
  }
  try {
    const pair = await refreshSundaySession(
      fetchFor(deps),
      gatewayFor(deps),
      stored.refresh_token,
      GATEWAY_TIMEOUT_MS,
    );
    const updated: StoredSession = {
      ...stored,
      session_token: pair.sessionToken,
      refresh_token: pair.refreshToken,
      updated_at: new Date().toISOString(),
    };
    saveStoredSession(updated, deps.homeDir);
    await tryDaemonConfigure(deps, pair.sessionToken);
    return { status: 'ok', session: updated, stale: false };
  } catch (e) {
    if (e instanceof GatewayError && e.status === 401) {
      deleteStoredSession(deps.homeDir);
      return { status: 'expired' };
    }
    // Transient failure: keep the stored tokens so a later retry can refresh.
    return { status: 'ok', session: stored, stale: true };
  }
}

// ---------------------------------------------------------------------------
// Google OAuth loopback flow — ported faithfully from extension.ts
// ---------------------------------------------------------------------------

function loopbackFlow(
  clientId: string,
  openUrl: (url: string) => Promise<void>,
): Promise<{ code: string; redirectUri: string; codeVerifier: string }> {
  // PKCE (RFC 7636) — required for loopback clients.
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    let settled = false;
    let redirectUri = '';
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        // already closed
      }
      fn();
    };
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<html><body style="font-family:sans-serif;text-align:center;padding-top:40px">' +
            '<h2>Google sign-in complete</h2><p>You can close this tab and return to Sunday.</p>' +
            '</body></html>',
        );
        if (error) {
          settle(() => reject(new Error(`Google OAuth error: ${error}`)));
        } else if (!code || returnedState !== state) {
          settle(() =>
            reject(new Error('Google OAuth: invalid callback (missing code or state mismatch)')),
          );
        } else {
          // redirectUri is captured at listen time (server.address() is
          // unreliable after close() — the one deliberate improvement over
          // the extension's in-handler address lookup).
          settle(() => resolve({ code, redirectUri, codeVerifier }));
        }
      } catch (e) {
        settle(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });

    const timer = setTimeout(() => {
      settle(() => reject(new Error('Sign-in was cancelled or timed out.')));
    }, SIGN_IN_TIMEOUT_MS);
    timer.unref?.();

    server.on('error', (e) => settle(() => reject(e)));

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
      });
      void Promise.resolve()
        .then(() => openUrl(`${GOOGLE_AUTH_URL}?${params}`))
        .catch((e: unknown) =>
          settle(() => reject(e instanceof Error ? e : new Error(String(e)))),
        );
    });
  });
}

async function googleFetchJson(
  fetchImpl: HttpFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`request failed (HTTP ${res.status})`);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeCode(
  fetchImpl: HttpFetch,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  clientId: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  let body: Record<string, unknown>;
  try {
    body = await googleFetchJson(fetchImpl, GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
      }).toString(),
    });
  } catch (e) {
    throw new Error(
      `Google token exchange ${e instanceof Error ? e.message : 'failed'}`,
    );
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('Google token exchange: no access token returned');
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
  };
}

async function fetchUserinfo(
  fetchImpl: HttpFetch,
  accessToken: string,
): Promise<{ sub: string; email?: string; name?: string }> {
  let body: Record<string, unknown>;
  try {
    body = await googleFetchJson(fetchImpl, GOOGLE_USERINFO_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    throw new Error(`Google userinfo ${e instanceof Error ? e.message : 'failed'}`);
  }
  if (typeof body.sub !== 'string' || !body.sub) {
    throw new Error('Google userinfo: no sub returned');
  }
  return {
    sub: body.sub,
    email: typeof body.email === 'string' ? body.email : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
  };
}

/** Best-effort Google token revocation — never throws, never logs the token. */
async function revokeGoogleToken(fetchImpl: HttpFetch, token: string): Promise<void> {
  try {
    await fetchImpl(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    // Best-effort: local sign-out proceeds regardless.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full sign-in: loopback Google OAuth → gateway session exchange → persist
 * session.json → best-effort daemon configure. Never throws for expected
 * failures; they are returned as `{ signedIn: false, error }`.
 */
export async function signIn(deps: AccountManagerDeps): Promise<AccountStatusOut> {
  if (!deps.openUrl) {
    return { signedIn: false, error: 'Sign-in is not available in this context.' };
  }
  const fetchImpl = fetchFor(deps);
  const gatewayUrl = gatewayFor(deps);
  const clientId = deps.googleClientId ?? GOOGLE_CLIENT_ID;

  let google: { accessToken: string; refreshToken?: string };
  let userinfo: { sub: string; email?: string; name?: string };
  try {
    const { code, redirectUri, codeVerifier } = await loopbackFlow(clientId, deps.openUrl);
    google = await exchangeCode(fetchImpl, code, redirectUri, codeVerifier, clientId);
    userinfo = await fetchUserinfo(fetchImpl, google.accessToken);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      signedIn: false,
      error: message === 'Sign-in was cancelled or timed out.' ? message : `Sign-in failed: ${message}`,
    };
  }

  let exchanged: { sessionToken: string; refreshToken: string; user: SundayUser };
  try {
    exchanged = await exchangeGoogleToken(
      fetchImpl,
      gatewayUrl,
      google.accessToken,
      GATEWAY_TIMEOUT_MS,
      machineId(deps.homeDir),
    );
  } catch (e) {
    if (e instanceof GatewayError && e.code === 'account_switch_limit') {
      const retryNote =
        e.retryAfterSec && e.retryAfterSec > 60
          ? ` (try again in ~${Math.ceil(e.retryAfterSec / 3600)}h)`
          : '';
      return {
        signedIn: false,
        error:
          `You've signed in with 2 Google accounts on this device in the last 24 hours${retryNote}. ` +
          'Try again tomorrow — or upgrade to a paid plan for unlimited switching.',
      };
    }
    const detail = e instanceof Error ? e.message : 'unknown error';
    return {
      signedIn: false,
      error: `Sunday gateway unavailable — sign-in could not be completed. (${detail})`,
    };
  }

  // Gateway user is authoritative; fall back to Google userinfo if the
  // gateway returned a sparse profile.
  const user: SundayUser = {
    id: exchanged.user.id || userinfo.sub,
    email: exchanged.user.email ?? userinfo.email,
    display_name: exchanged.user.display_name ?? userinfo.name,
    avatar_url: exchanged.user.avatar_url,
  };

  const plan = await fetchPlan(fetchImpl, gatewayUrl, exchanged.sessionToken);

  saveStoredSession(
    {
      session_token: exchanged.sessionToken,
      refresh_token: exchanged.refreshToken,
      user,
      google_refresh_token: google.refreshToken,
      google_access_token: google.accessToken,
      plan,
      updated_at: new Date().toISOString(),
    },
    deps.homeDir,
  );

  await tryDaemonConfigure(deps, exchanged.sessionToken);

  return { signedIn: true, user: toUserOut(user), plan };
}

/** Current account status — see AccountStatusOut.stale for offline semantics. */
export async function getAccountStatus(
  deps: AccountManagerDeps = {},
): Promise<AccountStatusOut> {
  const ensured = await ensureFreshSession(deps);
  if (ensured.status !== 'ok') {
    return { signedIn: false };
  }
  return {
    signedIn: true,
    user: toUserOut(ensured.session.user),
    plan: ensured.session.plan,
    stale: ensured.stale || undefined,
  };
}

/**
 * Today's quota from GET /me/usage/today?streak_days=0. Ensures a fresh
 * session first (refreshing when needed). 401 from the gateway clears the
 * stored session and returns `{ error: 'session expired' }`.
 */
export async function getQuota(deps: AccountManagerDeps = {}): Promise<QuotaResult> {
  const ensured = await ensureFreshSession(deps);
  if (ensured.status === 'signed-out') return { error: 'not signed in' };
  if (ensured.status === 'expired') return { error: 'session expired' };

  const fetchImpl = fetchFor(deps);
  const gatewayUrl = gatewayFor(deps);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${gatewayUrl}/me/usage/today?streak_days=0`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ensured.session.session_token}` },
      signal: controller.signal,
    });
    if (res.status === 401) {
      deleteStoredSession(deps.homeDir);
      return { error: 'session expired' };
    }
    if (!res.ok) {
      return { error: `quota request failed (HTTP ${res.status})` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    return {
      requestsUsed: num(body.requests),
      tokensIn: num(body.tokens_in),
      tokensOut: num(body.tokens_out),
      baseQuota: num(body.base_quota),
      totalQuota: num(body.total_quota),
      quotaRemaining: num(body.quota_remaining),
    };
  } catch {
    return { error: 'could not load quota (network error)' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sign out: best-effort gateway logout, best-effort Google token revocation
 * (access AND refresh — revoking only the access token would leave the
 * long-lived refresh token valid), best-effort daemon clear, then the local
 * session file is always deleted. Never throws.
 *
 * Daemon-clear caveat: see configureDaemonWithSession — an already-running
 * daemon does not unset its in-memory SUNDAY_API_TOKEN on an empty-token
 * configure (daemon only assigns when truthy). The gateway session itself
 * IS revoked server-side above, so the daemon's stale copy is useless.
 */
export async function signOut(deps: AccountManagerDeps = {}): Promise<void> {
  const stored = loadStoredSession(deps.homeDir);
  const fetchImpl = fetchFor(deps);
  try {
    if (stored?.refresh_token) {
      await logoutSundaySession(fetchImpl, gatewayFor(deps), stored.refresh_token, GATEWAY_TIMEOUT_MS);
    }
    if (stored?.google_access_token) {
      await revokeGoogleToken(fetchImpl, stored.google_access_token);
    }
    if (stored?.google_refresh_token && stored.google_refresh_token !== stored.google_access_token) {
      await revokeGoogleToken(fetchImpl, stored.google_refresh_token);
    }
    await tryDaemonConfigure(deps, '');
  } finally {
    deleteStoredSession(deps.homeDir);
  }
}
