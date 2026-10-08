/**
 * @sunday/hosted-gateway — Sunday Accounts service (Phase 9.a).
 *
 * Issues Sunday session JWTs to IDE users who sign in with Google:
 *   POST /auth/session   Google access token  -> session JWT + refresh token
 *   POST /auth/refresh   refresh token (rotate) -> new session JWT + new refresh
 *   POST /auth/logout    refresh token and/or session JWT -> revoke
 *   GET  /me/entitlements                    -> plan + basic entitlements
 *
 * Storage is two JSON files (`data/users.json`, `data/sessions.json`) under
 * the package dir, written atomically (tmp + rename) with 0600 files in a
 * 0700 dir. This is a deliberate stopgap for Phase 9.a (no billing yet):
 * billing (Phase 9.c) REQUIRES Postgres — flat files are not safe under
 * concurrent writers (lost updates on refresh-token rotation) and cannot
 * enforce the idempotency ledger billing webhooks need. Render's free tier
 * ships no managed Postgres, so the move happens when billing work starts.
 *
 * Security notes:
 *  - Session JWTs are HS256, signed with SUNDAY_SESSION_SECRET. Verification
 *    is signature-first, then alg-pinned to HS256 (no `none` alg), then exp.
 *  - Refresh tokens are stored only as SHA-256 hex hashes; the raw token is
 *    returned exactly once at issuance. Comparison is `timingSafeEqual`.
 *  - Google tokens, raw refresh tokens, and hashes are NEVER logged.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeEntitlements, planOrBasic } from './entitlements.js';
import type { Entitlements, PlanId, PlansFile } from './entitlements.js';
import { ApiError } from './openai-api.js';

/**
 * Google OAuth client ID of the Sunday IDE (the one the user signs in
 * with in the editor). Copied from
 * vscode/extensions/sunday-google-auth/src/extension.ts (DEFAULT_CLIENT_ID).
 * tokeninfo `aud` is checked against this — mismatch only warns, because
 * client IDs can rotate.
 */
export const SUNDAY_GOOGLE_CLIENT_ID =
  '110112861017-vceq10n514dajcj2hakr1mulk2feop6t.apps.googleusercontent.com';

const SESSION_TTL_S = 3600; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const GOOGLE_FETCH_TIMEOUT_MS = 8000;

export interface UserRecord {
  id: string;
  google_sub: string;
  email: string;
  display_name: string;
  avatar_url: string;
  /** Phase 9.b: widened from 'basic' — see plans.json templates. */
  plan: PlanId;
  created_at: string;
}

export interface SessionRecord {
  /** SHA-256 hex of the raw refresh token (never the raw token). */
  token_hash: string;
  user_id: string;
  issued_at: number;
  expires_at: number;
  /** Epoch ms of revocation, or null when live. */
  revoked_at: number | null;
}

/** The Basic-plan entitlements every account gets (Phase 9.a; no paid plans yet). */
export const BASIC_ENTITLEMENTS = {
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
} as const;

export interface EntitlementsResponse {
  plan: PlanId;
  entitlements: Entitlements;
}

export function basicEntitlements(): EntitlementsResponse {
  return { plan: 'basic', entitlements: BASIC_ENTITLEMENTS };
}

export interface GoogleAccountInfo {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

export interface AccountsDeps {
  /** Directory holding users.json/sessions.json. Default: `<pkg>/data`. */
  dataDir?: string;
  /** fetch implementation (tests inject a mock; never hits Google). */
  fetchFn?: typeof fetch;
  /**
   * Loaded plan templates (Phase 9.b). When present, /auth/session returns
   * the user's plan entitlements instead of the Basic fallback. The
   * production server always passes the startup-loaded plans; the fallback
   * path exists only for unit tests that construct the service directly.
   */
  plans?: PlansFile;
}

/** Default storage dir: `data/` under the package root (src/ and dist/ both resolve the same way). */
export function defaultDataDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
}

function b64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex hash strings (both fixed length). */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Verify a Google OAuth access token: tokeninfo for validity/expiry (and a
 * soft `aud` check), then userinfo for profile fields. Reuses the
 * social-auth fetch/timeout pattern. Returns null on any failure; the raw
 * token is never logged.
 */
export async function verifyGoogleToken(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<GoogleAccountInfo | null> {
  if (!accessToken || typeof accessToken !== 'string') return null;
  const timeout = AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS);
  const headers = { Accept: 'application/json', 'User-Agent': 'sunday-hosted-gateway' };

  let tiRes: Response;
  try {
    tiRes = await fetchFn(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
      { signal: timeout, headers },
    );
  } catch {
    return null;
  }
  if (tiRes.status !== 200) return null;
  let ti: Record<string, unknown>;
  try {
    const parsed: unknown = await tiRes.json();
    if (!isRecord(parsed)) return null;
    ti = parsed;
  } catch {
    return null;
  }
  if (typeof ti.sub !== 'string' || ti.sub.length === 0) return null;
  if (Number(ti.expires_in) <= 0) return null;
  if (typeof ti.aud === 'string' && ti.aud !== SUNDAY_GOOGLE_CLIENT_ID) {
    // Soft check only — client IDs rotate; do not hard-fail or log the token.
    console.warn('[accounts] Google tokeninfo aud mismatch (client ID may have rotated)');
  }

  let uiRes: Response;
  try {
    uiRes = await fetchFn('https://www.googleapis.com/oauth2/v3/userinfo', {
      signal: timeout,
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return null;
  }
  if (!uiRes.ok) return null;
  let ui: Record<string, unknown>;
  try {
    const parsed: unknown = await uiRes.json();
    if (!isRecord(parsed)) return null;
    ui = parsed;
  } catch {
    return null;
  }
  if (typeof ui.sub !== 'string' || ui.sub.length === 0) return null;
  return {
    sub: ui.sub,
    email: typeof ui.email === 'string' ? ui.email : '',
    name: typeof ui.name === 'string' ? ui.name : '',
    picture: typeof ui.picture === 'string' ? ui.picture : '',
  };
}

export class AccountsService {
  private readonly sessionSecret: string;
  private readonly dataDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly plans: PlansFile | undefined;
  private users: UserRecord[] = [];
  private sessions: SessionRecord[] = [];

  constructor(sessionSecret: string, deps: AccountsDeps = {}) {
    if (!sessionSecret || sessionSecret.length === 0) {
      throw new Error('accounts require a non-empty SUNDAY_SESSION_SECRET');
    }
    this.sessionSecret = sessionSecret;
    this.dataDir = deps.dataDir ?? defaultDataDir();
    this.fetchFn = deps.fetchFn ?? fetch;
    this.plans = deps.plans;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.users = this.loadJson<UserRecord[]>('users.json', []);
    this.sessions = this.loadJson<SessionRecord[]>('sessions.json', []);
    // Phase 9.b migration: records written before plans existed may lack
    // `plan` (or carry an unknown value) — they keep working as Basic, and
    // the normalized record is persisted so the migration runs once.
    let migrated = false;
    for (const u of this.users) {
      if (u.plan !== 'basic' && u.plan !== 'smart' && u.plan !== 'pro') {
        u.plan = 'basic';
        migrated = true;
      }
    }
    if (migrated) this.saveJson('users.json', this.users);
  }

  private loadJson<T>(name: string, fallback: T): T {
    const p = join(this.dataDir, name);
    if (!existsSync(p)) return fallback;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  /** Atomic write (tmp + rename), file 0600, so a crash never leaves a half file. */
  private saveJson(name: string, value: unknown): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dataDir, `${name}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(this.dataDir, name));
  }

  /** Issue an HS256 Sunday session JWT for a user id (1h TTL). */
  issueSessionToken(userId: string): string {
    const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const nowS = Math.floor(Date.now() / 1000);
    const payload = b64urlEncode(JSON.stringify({ sub: userId, iat: nowS, exp: nowS + SESSION_TTL_S }));
    const sig = createHmac('sha256', this.sessionSecret)
      .update(`${header}.${payload}`, 'utf8')
      .digest('base64url');
    return `${header}.${payload}.${sig}`;
  }

  /**
   * Verify a Sunday session JWT. Returns the user id, or undefined for
   * malformed / wrong-signature / wrong-secret / expired tokens.
   */
  verifySessionToken(token: string | undefined): string | undefined {
    if (!token || typeof token !== 'string') return undefined;
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const [h, p, s] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      const hp: unknown = JSON.parse(b64urlDecode(h));
      const pp: unknown = JSON.parse(b64urlDecode(p));
      if (!isRecord(hp) || !isRecord(pp)) return undefined;
      header = hp;
      payload = pp;
    } catch {
      return undefined;
    }
    // Pin the algorithm: never accept `none` or anything but HS256.
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return undefined;

    const expected = createHmac('sha256', this.sessionSecret)
      .update(`${h}.${p}`, 'utf8')
      .digest();
    let sig: Buffer;
    try {
      sig = Buffer.from(s, 'base64url');
    } catch {
      return undefined;
    }
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return undefined;

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return undefined;
    const nowS = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowS) return undefined;
    return payload.sub;
  }

  /** Find or create the user for a Google sub. */
  private findOrCreateUser(info: GoogleAccountInfo): UserRecord {
    const existing = this.users.find((u) => u.google_sub === info.sub);
    if (existing) return existing;
    const user: UserRecord = {
      id: `u_${randomBytes(8).toString('hex')}`,
      google_sub: info.sub,
      email: info.email,
      display_name: info.name,
      avatar_url: info.picture,
      plan: 'basic',
      created_at: new Date().toISOString(),
    };
    this.users.push(user);
    this.saveJson('users.json', this.users);
    return user;
  }

  private mintRefreshToken(userId: string): { raw: string; record: SessionRecord } {
    const raw = randomBytes(32).toString('base64url');
    const now = Date.now();
    const record: SessionRecord = {
      token_hash: sha256Hex(raw),
      user_id: userId,
      issued_at: now,
      expires_at: now + REFRESH_TTL_MS,
      revoked_at: null,
    };
    this.sessions.push(record);
    this.saveJson('sessions.json', this.sessions);
    return { raw, record };
  }

  private findSessionByRaw(raw: string): SessionRecord | undefined {
    const hash = sha256Hex(raw);
    return this.sessions.find((s) => safeEqualHex(s.token_hash, hash));
  }

  /** Plan-aware entitlements payload for /auth/session (Phase 9.a shape kept). */
  private sessionEntitlements(user: UserRecord): EntitlementsResponse {
    if (this.plans) {
      const view = computeEntitlements(user.id, planOrBasic(user.plan, this.plans), this.plans);
      return { plan: view.plan, entitlements: view.entitlements };
    }
    return basicEntitlements();
  }

  /**
   * POST /auth/session: verify the Google access token, find/create the
   * user, issue a session JWT + refresh token. 400 when the token is
   * missing, 401 when Google rejects it.
   */
  async createSession(googleAccessToken: unknown): Promise<{
    session_token: string;
    refresh_token: string;
    user: { id: string; email: string; display_name: string; avatar_url: string };
    entitlements: EntitlementsResponse;
  }> {
    if (typeof googleAccessToken !== 'string' || googleAccessToken.length === 0) {
      throw new ApiError(400, 'missing_google_token', 'body must include google_access_token');
    }
    const info = await verifyGoogleToken(googleAccessToken, this.fetchFn);
    if (!info) {
      throw new ApiError(401, 'invalid_google_token', 'Google token verification failed');
    }
    const user = this.findOrCreateUser(info);
    const { raw } = this.mintRefreshToken(user.id);
    return {
      session_token: this.issueSessionToken(user.id),
      refresh_token: raw,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      },
      entitlements: this.sessionEntitlements(user),
    };
  }

  /**
   * POST /auth/refresh: rotate the presented refresh token. The old token
   * is revoked first and can never be reused (replay -> 401).
   */
  rotateRefreshToken(rawRefreshToken: unknown): { session_token: string; refresh_token: string } {
    if (typeof rawRefreshToken !== 'string' || rawRefreshToken.length === 0) {
      throw new ApiError(400, 'missing_refresh_token', 'body must include refresh_token');
    }
    const rec = this.findSessionByRaw(rawRefreshToken);
    const now = Date.now();
    if (!rec || rec.revoked_at !== null || rec.expires_at <= now) {
      throw new ApiError(401, 'invalid_refresh_token', 'refresh token is invalid or expired');
    }
    // Revoke before minting: a crash between these two lines leaves the
    // client with a 500, never with two live refresh tokens.
    rec.revoked_at = now;
    const { raw } = this.mintRefreshToken(rec.user_id);
    this.saveJson('sessions.json', this.sessions);
    return {
      session_token: this.issueSessionToken(rec.user_id),
      refresh_token: raw,
    };
  }

  /**
   * POST /auth/logout: idempotent. Revokes the presented refresh token, or
   * — when identified by a valid session JWT in `bearer` — ALL refresh
   * tokens of that user. Unknown tokens still return success.
   */
  logout(rawRefreshToken: unknown, bearer: string | undefined): void {
    const now = Date.now();
    let changed = false;
    if (typeof rawRefreshToken === 'string' && rawRefreshToken.length > 0) {
      const rec = this.findSessionByRaw(rawRefreshToken);
      if (rec && rec.revoked_at === null) {
        rec.revoked_at = now;
        changed = true;
      }
    }
    const userId = this.verifySessionToken(bearer);
    if (userId) {
      for (const s of this.sessions) {
        if (s.user_id === userId && s.revoked_at === null) {
          s.revoked_at = now;
          changed = true;
        }
      }
    }
    if (changed) this.saveJson('sessions.json', this.sessions);
  }

  /** Look up a user for /me responses. */
  getUser(userId: string): UserRecord | undefined {
    return this.users.find((u) => u.id === userId);
  }

  /**
   * Phase 9.b admin toggle: set a user's plan and persist the record
   * (atomic write, same as every other user mutation). Returns the updated
   * record, or undefined for an unknown user id. Callers validate the plan
   * id before calling.
   */
  setUserPlan(userId: string, plan: PlanId): UserRecord | undefined {
    const user = this.users.find((u) => u.id === userId);
    if (!user) return undefined;
    user.plan = plan;
    this.saveJson('users.json', this.users);
    return user;
  }

  /** Test hook: number of live (unrevoked, unexpired) sessions. */
  liveSessionCount(): number {
    const now = Date.now();
    return this.sessions.filter((s) => s.revoked_at === null && s.expires_at > now).length;
  }
}
