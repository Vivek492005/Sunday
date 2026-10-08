/**
 * @sunday/hosted-gateway — separate admin login gateway.
 *
 * A second, allowlist-gated login path for the founder / company members.
 * Admins sign in with Google or Microsoft OAuth (same token verification as
 * /auth/session) but through POST /admin/login, which only succeeds when the
 * verified email is in SUNDAY_ADMIN_EMAILS. Admin sessions:
 *
 *  - carry `role: "admin"` and `iss: "sunday-admin"` claims, signed with the
 *    same SUNDAY_SESSION_SECRET as user sessions (8h TTL, refreshable);
 *  - are stateful: every access token maps to a server-side session record,
 *    so POST /admin/logout revokes the session immediately;
 *  - bypass user-level restrictions (account-switch limit, daily quota);
 *  - NEVER bypass webhook signature verification or x-admin-key checks
 *    (defense in depth — those paths don't consult sessions at all).
 *
 * Security notes:
 *  - Fail closed: when SUNDAY_ADMIN_EMAILS is unset/empty, every admin login
 *    fails — there is no default admin.
 *  - The 403 for non-allowlisted emails reveals nothing about who IS admin.
 *  - Admin emails are never logged in plaintext — only a truncated SHA-256.
 *  - /admin/login gets its own 5 req/min/IP bucket on top of the /auth/*
 *    20 req/min bucket (brute-force backstop).
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
import { verifyGoogleToken } from './accounts.js';
import { ApiError } from './openai-api.js';

/** Admin access-token lifetime: 8h (shorter than the 30d user refresh window). */
export const ADMIN_TOKEN_TTL_S = 8 * 3600;
/** Distinct issuer so admin tokens can never validate as user sessions. */
export const ADMIN_TOKEN_ISSUER = 'sunday-admin';
const ADMIN_REFRESH_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const ADMIN_FETCH_TIMEOUT_MS = 8000;

/** Permissions advertised by GET /admin/me. */
export const ADMIN_PERMISSIONS = [
  'admin:session:manage',
  'admin:bypass:account-switch-limit',
  'admin:bypass:daily-quota',
] as const;

export type AdminOAuthProvider = 'google' | 'microsoft';

export interface MicrosoftAccountInfo {
  sub: string;
  email: string;
  name: string;
}

/**
 * Parse SUNDAY_ADMIN_EMAILS: comma-separated, trimmed, lowercased.
 * Empty/unset -> [] (fail closed: no admin logins allowed).
 */
export function parseAdminEmails(env: string | undefined): string[] {
  if (!env) return [];
  return env
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Truncated SHA-256 of an email — safe for logs, never the plaintext. */
export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
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

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Verify a Microsoft OAuth access token via Graph /me. Returns the account
 * identity, or null on any failure. The email comes from `mail` with a
 * `userPrincipalName` fallback (personal Microsoft accounts).
 */
export async function verifyMicrosoftToken(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<MicrosoftAccountInfo | null> {
  if (!accessToken || typeof accessToken !== 'string') return null;
  const timeout = AbortSignal.timeout(ADMIN_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn('https://graph.microsoft.com/v1.0/me', {
      signal: timeout,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'sunday-hosted-gateway',
      },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await res.json();
    if (!isRecord(parsed)) return null;
    body = parsed;
  } catch {
    return null;
  }
  if (typeof body.id !== 'string' || body.id.length === 0) return null;
  const mail = typeof body.mail === 'string' ? body.mail : '';
  const upn = typeof body.userPrincipalName === 'string' ? body.userPrincipalName : '';
  const email = mail.includes('@') ? mail : upn.includes('@') ? upn : '';
  if (!email) return null;
  return {
    sub: body.id,
    email,
    name: typeof body.displayName === 'string' ? body.displayName : '',
  };
}

export interface AdminAuditEvent {
  ts: string;
  ip: string;
  /** Truncated SHA-256 of the attempted email — never plaintext. */
  emailHash: string;
  provider: string;
  success: boolean;
  /** Machine-readable reason on failure (e.g. "not_admin", "invalid_token"). */
  reason?: string;
  httpStatus: number;
}

export interface AdminServiceDeps {
  /** Directory holding admin_sessions.json / admin_refresh.json. */
  dataDir?: string;
  /** fetch implementation (tests inject a mock; never hits providers). */
  fetchFn?: typeof fetch;
  /** Called for every login attempt (success AND failure). */
  onAudit?: (e: AdminAuditEvent) => void;
}

interface AdminSessionRecord {
  jti: string;
  email: string;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}

interface AdminRefreshRecord {
  /** SHA-256 hex of the raw refresh token (never the raw token). */
  token_hash: string;
  email: string;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface AdminLoginResult {
  admin_token: string;
  refresh_token: string;
  admin: { email: string; role: 'admin' };
}

export function defaultAdminDataDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
}

export class AdminService {
  private readonly sessionSecret: string;
  private readonly adminEmails: string[];
  private readonly dataDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly onAudit?: (e: AdminAuditEvent) => void;
  private sessions: AdminSessionRecord[] = [];
  private refreshTokens: AdminRefreshRecord[] = [];

  constructor(sessionSecret: string, adminEmails: string[], deps: AdminServiceDeps = {}) {
    if (!sessionSecret || sessionSecret.length === 0) {
      throw new Error('admin auth requires a non-empty SUNDAY_SESSION_SECRET');
    }
    this.sessionSecret = sessionSecret;
    this.adminEmails = adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    this.dataDir = deps.dataDir ?? defaultAdminDataDir();
    this.fetchFn = deps.fetchFn ?? fetch;
    this.onAudit = deps.onAudit;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.sessions = this.loadJson<AdminSessionRecord[]>('admin_sessions.json', []);
    this.refreshTokens = this.loadJson<AdminRefreshRecord[]>('admin_refresh.json', []);
  }

  /** False when SUNDAY_ADMIN_EMAILS is unset — every login fails closed. */
  isConfigured(): boolean {
    return this.adminEmails.length > 0;
  }

  /** Case-insensitive allowlist check. */
  isAdminEmail(email: string): boolean {
    return this.adminEmails.includes(email.trim().toLowerCase());
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

  /** Atomic write (tmp + rename), file 0600. */
  private saveJson(name: string, value: unknown): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dataDir, `${name}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(this.dataDir, name));
  }

  private audit(ip: string, emailForHash: string, provider: string, success: boolean, reason: string | undefined, httpStatus: number): void {
    try {
      this.onAudit?.({
        ts: new Date().toISOString(),
        ip,
        emailHash: emailHash(emailForHash || 'unknown'),
        provider,
        success,
        reason,
        httpStatus,
      });
    } catch {
      // Audit must never break the login flow.
    }
  }

  /**
   * Issue an admin access JWT: HS256, iss=sunday-admin, role=admin, 8h TTL.
   * Stored server-side (stateful) so logout revokes immediately.
   */
  issueAdminToken(email: string): string {
    const jti = randomBytes(12).toString('hex');
    const now = Date.now();
    const nowS = Math.floor(now / 1000);
    const normalized = email.trim().toLowerCase();
    const record: AdminSessionRecord = {
      jti,
      email: normalized,
      issued_at: now,
      expires_at: now + ADMIN_TOKEN_TTL_S * 1000,
      revoked_at: null,
    };
    this.sessions.push(record);
    this.saveJson('admin_sessions.json', this.sessions);

    const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64urlEncode(
      JSON.stringify({
        sub: `admin:${normalized}`,
        email: normalized,
        role: 'admin',
        iss: ADMIN_TOKEN_ISSUER,
        jti,
        iat: nowS,
        exp: nowS + ADMIN_TOKEN_TTL_S,
      }),
    );
    const sig = createHmac('sha256', this.sessionSecret)
      .update(`${header}.${payload}`, 'utf8')
      .digest('base64url');
    return `${header}.${payload}.${sig}`;
  }

  /**
   * Verify an admin access JWT: signature, alg pin, issuer, role, expiry,
   * and a live server-side session record. Returns {email, jti} or
   * undefined. Never throws.
   */
  verifyAdminToken(token: string | undefined): { email: string; jti: string } | undefined {
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
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return undefined;
    if (payload.iss !== ADMIN_TOKEN_ISSUER) return undefined;
    if (payload.role !== 'admin') return undefined;

    const expected = createHmac('sha256', this.sessionSecret).update(`${h}.${p}`, 'utf8').digest();
    let sig: Buffer;
    try {
      sig = Buffer.from(s, 'base64url');
    } catch {
      return undefined;
    }
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return undefined;

    if (typeof payload.jti !== 'string' || payload.jti.length === 0) return undefined;
    if (typeof payload.email !== 'string' || payload.email.length === 0) return undefined;
    const nowS = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowS) return undefined;

    // Stateful check: the session must exist and not be revoked/expired.
    const rec = this.sessions.find((r) => r.jti === payload.jti);
    const now = Date.now();
    if (!rec || rec.revoked_at !== null || rec.expires_at <= now) return undefined;
    return { email: rec.email, jti: rec.jti };
  }

  /**
   * Middleware helper: returns the admin email for a valid admin Bearer
   * token, or throws 401. Use for /admin/me, /admin/logout, /admin/refresh.
   */
  requireAdmin(bearer: string | undefined): string {
    const verified = this.verifyAdminToken(bearer);
    if (!verified) {
      throw new ApiError(401, 'admin_unauthorized', 'valid admin session required');
    }
    return verified.email;
  }

  private mintAdminRefresh(email: string): { raw: string } {
    const raw = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.refreshTokens.push({
      token_hash: sha256Hex(raw),
      email,
      issued_at: now,
      expires_at: now + ADMIN_REFRESH_TTL_MS,
      revoked_at: null,
    });
    this.saveJson('admin_refresh.json', this.refreshTokens);
    return { raw };
  }

  private findRefreshByRaw(raw: string): AdminRefreshRecord | undefined {
    const hash = sha256Hex(raw);
    return this.refreshTokens.find((r) => safeEqualHex(r.token_hash, hash));
  }

  /**
   * POST /admin/login: verify the OAuth token, enforce the allowlist, and
   * issue an admin session. Audited on every attempt (success and failure).
   * Throws 400 (bad input), 401 (bad OAuth token), 403 (not allowlisted),
   * 503 (admin login not configured — fail closed).
   */
  async login(idToken: unknown, provider: unknown, ip: string): Promise<AdminLoginResult> {
    const providerStr = typeof provider === 'string' ? provider : '';
    if (!this.isConfigured()) {
      this.audit(ip, 'unknown', providerStr || 'unknown', false, 'not_configured', 403);
      throw new ApiError(403, 'admin_not_configured', 'admin login is not configured on this gateway');
    }
    if (providerStr !== 'google' && providerStr !== 'microsoft') {
      this.audit(ip, 'unknown', providerStr || 'unknown', false, 'invalid_provider', 400);
      throw new ApiError(400, 'invalid_provider', 'provider must be "google" or "microsoft"');
    }
    if (typeof idToken !== 'string' || idToken.length === 0) {
      this.audit(ip, 'unknown', providerStr, false, 'missing_token', 400);
      throw new ApiError(400, 'missing_id_token', 'body must include idToken');
    }

    const info =
      providerStr === 'google'
        ? await verifyGoogleToken(idToken, this.fetchFn)
        : await verifyMicrosoftToken(idToken, this.fetchFn);
    if (!info || !info.email) {
      this.audit(ip, 'unknown', providerStr, false, 'invalid_token', 401);
      throw new ApiError(401, 'invalid_admin_token', 'OAuth token verification failed');
    }
    if (!this.isAdminEmail(info.email)) {
      // Generic message: never reveal who IS on the allowlist.
      this.audit(ip, info.email, providerStr, false, 'not_admin', 403);
      throw new ApiError(403, 'not_admin', 'This login is restricted to administrators.');
    }

    const email = info.email.trim().toLowerCase();
    this.audit(ip, email, providerStr, true, undefined, 200);
    const { raw } = this.mintAdminRefresh(email);
    return {
      admin_token: this.issueAdminToken(email),
      refresh_token: raw,
      admin: { email, role: 'admin' },
    };
  }

  /**
   * POST /admin/refresh: rotate the admin refresh token. The old token is
   * revoked first and can never be reused (replay -> 401).
   */
  rotateAdminRefresh(rawRefreshToken: unknown): { admin_token: string; refresh_token: string } {
    if (typeof rawRefreshToken !== 'string' || rawRefreshToken.length === 0) {
      throw new ApiError(400, 'missing_refresh_token', 'body must include refresh_token');
    }
    const rec = this.findRefreshByRaw(rawRefreshToken);
    const now = Date.now();
    if (!rec || rec.revoked_at !== null || rec.expires_at <= now) {
      throw new ApiError(401, 'invalid_refresh_token', 'refresh token is invalid or expired');
    }
    rec.revoked_at = now;
    const { raw } = this.mintAdminRefresh(rec.email);
    this.saveJson('admin_refresh.json', this.refreshTokens);
    return { admin_token: this.issueAdminToken(rec.email), refresh_token: raw };
  }

  /**
   * POST /admin/logout: revoke the presented refresh token and the access
   * session identified by the Bearer admin token. Idempotent — unknown
   * tokens still return success (no oracle for token validity).
   */
  logoutAdmin(rawRefreshToken: unknown, bearer: string | undefined): void {
    const now = Date.now();
    let changed = false;
    if (typeof rawRefreshToken === 'string' && rawRefreshToken.length > 0) {
      const rec = this.findRefreshByRaw(rawRefreshToken);
      if (rec && rec.revoked_at === null) {
        rec.revoked_at = now;
        changed = true;
      }
    }
    const verified = this.verifyAdminToken(bearer);
    if (verified) {
      const rec = this.sessions.find((r) => r.jti === verified.jti);
      if (rec && rec.revoked_at === null) {
        rec.revoked_at = now;
        changed = true;
      }
    }
    if (changed) {
      this.saveJson('admin_sessions.json', this.sessions);
      this.saveJson('admin_refresh.json', this.refreshTokens);
    }
  }

  /**
   * GET /admin/me: admin profile + permission list for a valid session.
   */
  me(bearer: string | undefined): {
    email: string;
    role: 'admin';
    permissions: string[];
    issued_at: string;
    expires_at: string;
  } {
    const email = this.requireAdmin(bearer);
    const verified = this.verifyAdminToken(bearer);
    const rec = verified ? this.sessions.find((r) => r.jti === verified.jti) : undefined;
    return {
      email,
      role: 'admin',
      permissions: [...ADMIN_PERMISSIONS],
      issued_at: rec ? new Date(rec.issued_at).toISOString() : new Date().toISOString(),
      expires_at: rec ? new Date(rec.expires_at).toISOString() : new Date().toISOString(),
    };
  }
}
