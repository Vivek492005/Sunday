/**
 * @sunday/hosted-gateway — HTTP server with abuse controls.
 *
 * Middleware order per request:
 *   1. IP allowlist (403 when the operator configured one and the IP misses)
 *   2. Body read with a hard byte cap (413 on overflow)
 *   3. API key auth — Bearer, constant-time (401; skipped for /health and
 *      /auth/*); social OAuth, then gateway API key, then Sunday session
 *      JWT (9.a) as a fallback that never breaks the earlier modes
 *   3b. /auth/* strict per-IP rate limit (20 req/min, 429 + Retry-After)
 *   4. Request validation (400 on malformed / tools / disallowed model)
 *   5. Per-key token-bucket rate limit (429 + Retry-After)
 *   6. Upstream provider call (timeout + client-disconnect abort)
 *   7. Audit log line (always, even on early rejects)
 *
 * Only text chat is exposed. There is no shell, no file access, no tool
 * execution on this surface — by construction, not by policy flag.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createDefaultRegistry,
  Router,
  type ChatChunk,
  type ProviderRegistry,
} from '@sunday/gateway';
import type { HostedGatewayConfig } from './config.js';
import { KeyStore, keyFingerprint } from './auth.js';
import { IpRateLimiter, KeyRateLimiter } from './rate-limit.js';
import { AuditLog } from './audit.js';
import { ipAllowed, normalizeIp } from './ip-allowlist.js';
import { SocialVerifier, type SocialIdentity } from './social-auth.js';
import { DailyQuota } from './quota.js';
import type { QuotaType } from './quota.js';
import { getStreakBonus, parseStreakDays } from './streakBonus.js';
import { UsageMeter } from './usage.js';
import { MAX_SYNC_BLOB_BYTES, SyncStore } from './sync.js';
import { UpdateChecker, type UpdatePlatform } from './updates.js';
import { AccountsService, defaultDataDir } from './accounts.js';
import { AdminService, emailHash } from './admin-auth.js';
import { AgentTaskStore, publicTask, validateTaskInput } from './agent-tasks.js';
import {
  computeEntitlements,
  loadPlans,
  planOrBasic,
  type PlansFile,
} from './entitlements.js';
import {
  ApiError,
  chatCompletionObject,
  errorBody,
  modelsListObject,
  parseChatRequest,
  sseChunkObject,
} from './openai-api.js';

const VERSION = '0.1.0';

/** POST /admin/users/:id/plan — Phase 9.b admin plan toggle (testing only). */
const ADMIN_PLAN_ROUTE_RE = /^\/admin\/users\/([A-Za-z0-9_-]{1,64})\/plan$/;

/** POST /admin/signin-log/clear — clear account-switch log for a machine (support). */
const ADMIN_SIGNIN_LOG_CLEAR_RE = /^\/admin\/signin-log\/clear$/;

/**
 * Constant-time string comparison for the admin key. Lengths must match
 * first (timingSafeEqual throws on unequal lengths) — a wrong-length key
 * simply fails closed.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface ServerDeps {
  router?: Router;
  registry?: ProviderRegistry;
  /** Override the accounts data dir (tests use a tmp dir; default is <pkg>/data). */
  dataDir?: string;
  /** fetch impl for Google token verification (tests inject a mock). */
  accountsFetch?: typeof fetch;
}

export class HostedGatewayServer {
  private readonly keys: KeyStore;
  private readonly limiter: KeyRateLimiter;
  /** S8: per-IP backstop against sock-puppet farms (per-key limits multiply). */
  private readonly ipLimiter: IpRateLimiter;
  /** Phase 9.a: stricter per-IP limit on /auth/* (login endpoints are abuse magnets). */
  private readonly authIpLimiter: IpRateLimiter;
  /**
   * Separate admin gateway: even stricter per-IP limit on POST /admin/login
   * (5 req/min) — brute-force backstop on top of the /auth/* bucket.
   */
  private readonly adminLoginIpLimiter: IpRateLimiter;
  /** A1: per-IP limit on /agent/* (task queue is a new abuse surface). */
  private readonly agentIpLimiter: IpRateLimiter;
  private readonly audit: AuditLog;
  private readonly router: Router;
  private readonly registry: ProviderRegistry;
  private readonly social: SocialVerifier;
  private readonly quota: DailyQuota;
  /** D2: in-memory usage metering for GET /me/usage (see usage.ts). */
  private readonly usage: UsageMeter;
  /**
   * D3: per-user opaque sync-blob store. The server NEVER decrypts —
   * see the security contract in sync.ts.
   */
  private readonly syncStore: SyncStore;
  private readonly accounts: AccountsService;
  /**
   * Separate admin login gateway (allowlist-based, SUNDAY_ADMIN_EMAILS).
   * Admin sessions bypass user-level restrictions (account-switch limit,
   * daily quota) but never webhook signatures or x-admin-key checks.
   */
  private readonly adminAuth: AdminService;
  /** Phase 9.b: plan templates from data/plans.json (loaded once at startup). */
  private readonly plans: PlansFile;
  private readonly updates: UpdateChecker;
  /** A1: async agent task store (JSON file, 0600). */
  private readonly agentTasks: AgentTaskStore;
  private server: Server | undefined;

  constructor(
    private readonly config: HostedGatewayConfig,
    deps: ServerDeps = {},
  ) {
    this.keys = new KeyStore(config.keys);
    this.limiter = new KeyRateLimiter({
      requestsPerMinute: config.requestsPerMinute,
      tokensPerMinute: config.tokensPerMinute,
    });
    this.ipLimiter = new IpRateLimiter({ requestsPerMinute: 300 });
    this.authIpLimiter = new IpRateLimiter({ requestsPerMinute: 20 });
    // Separate admin gateway: 5 req/min/IP on POST /admin/login.
    this.adminLoginIpLimiter = new IpRateLimiter({ requestsPerMinute: 5 });
    // A1: 60 req/min/IP on the task queue — generous for polling, tight
    // enough to make queue-flooding expensive.
    this.agentIpLimiter = new IpRateLimiter({ requestsPerMinute: 60 });
    this.audit = new AuditLog(config.auditLog);
    // S8: restrict the server registry to paid upstream providers only.
    // The default registry includes `sunday:` (self-loop burning quota) and
    // `ollama:` (connection-refused on Render) — neither makes sense here.
    this.registry = deps.registry ?? createDefaultRegistry(['openrouter', 'groq']);
    this.router = deps.router ?? new Router(this.registry, 'openrouter:meta-llama/llama-3.3-70b-instruct');
    this.social = new SocialVerifier(this.config.oauthProviders);
    this.quota = new DailyQuota(config.dailyQuota);
    this.usage = new UsageMeter();
    this.syncStore = new SyncStore(deps.dataDir);
    // Phase 9.b: load plan templates once at startup. loadPlans() throws on
    // a missing file, bad JSON, or schema violations — fail closed: the
    // constructor throws, cli.ts prints the message and exits non-zero, so
    // the gateway never boots with unknown/empty plan templates.
    try {
      this.plans = loadPlans(deps.dataDir ?? defaultDataDir());
    } catch (err) {
      throw new Error(`cannot start hosted gateway: ${(err as Error).message}`);
    }
    this.accounts = new AccountsService(config.sessionSecret, {
      dataDir: deps.dataDir,
      fetchFn: deps.accountsFetch,
      plans: this.plans,
    });
    // Separate admin login gateway. Audit hook hashes admin emails before
    // they reach the audit sink (never plaintext). Fail-closed when
    // SUNDAY_ADMIN_EMAILS is unset: AdminService rejects every login.
    this.adminAuth = new AdminService(config.sessionSecret, config.adminEmails ?? [], {
      dataDir: deps.dataDir,
      fetchFn: deps.accountsFetch,
      onAudit: (e) => {
        this.audit.write({
          ts: e.ts,
          requestId: `admin-${randomUUID().slice(0, 8)}`,
          ip: e.ip,
          method: 'POST',
          path: '/admin/login',
          keyId: `admin:${e.emailHash}`,
          status: e.httpStatus,
          latencyMs: 0,
          promptTokensEst: 0,
          completionTokensEst: 0,
          error: e.success ? undefined : e.reason,
        });
      },
    });
    this.agentTasks = new AgentTaskStore(deps.dataDir ?? defaultDataDir());
    this.updates = new UpdateChecker();
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        // Last-resort: never leave a socket hanging.
        try {
          const { status, body } = errorBody(err);
          this.sendJson(res, status, body);
        } catch {
          res.destroy();
        }
      });
    });
    // S8: HTTP server hardening — slowloris protection on a small instance.
    this.server.maxConnections = 2000;
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => resolve());
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = undefined;
  }

  address(): { host: string; port: number } {
    const a = this.server?.address();
    if (a && typeof a === 'object') return { host: a.address, port: a.port };
    return { host: this.config.host, port: this.config.port };
  }

  private sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      ...extraHeaders,
    });
    res.end(text);
  }

  private readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let rejected = false;
      req.on('data', (c: Buffer) => {
        if (rejected) return;
        size += c.length;
        if (size > maxBytes) {
          rejected = true;
          // Stop consuming; the handler sends the 413 and then closes the
          // socket (see handle()), so a huge body can't pin the connection.
          req.pause();
          reject(new ApiError(413, 'body_too_large', `request body exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!rejected) resolve(Buffer.concat(chunks));
      });
      req.on('error', reject);
    });
  }

  /**
   * Read a JSON object body (empty body -> {}); throws 400 on invalid JSON.
   * `maxBytes` overrides the configured body cap for routes with their own
   * documented limit (e.g. the 5 MiB sync-blob cap).
   */
  private async parseJsonBody(
    req: IncomingMessage,
    maxBytes: number = this.config.maxBodyBytes,
  ): Promise<Record<string, unknown>> {
    const raw = await this.readBody(req, maxBytes);
    if (raw.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ApiError(400, 'invalid_json', 'request body must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'invalid_json', 'request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  }

  private clientIp(req: IncomingMessage): string {
    // No X-Forwarded-For trust: the gateway is expected to run behind the
    // operator's own TLS terminator, and trusting client-supplied headers
    // would let abusers spoof allowlisted IPs.
    return normalizeIp(req.socket.remoteAddress);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedMs = Date.now();
    const requestId = randomUUID().slice(0, 8);
    const ip = this.clientIp(req);
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    const auditBase = { ts: new Date().toISOString(), requestId, ip, method, path };
    let keyId = 'none';
    let status = 500;
    let model: string | undefined;
    let promptTokensEst = 0;
    let completionTokensEst = 0;
    let quotaType: QuotaType = 'base';
    let error: string | undefined;

    try {
      const isHealth = method === 'GET' && path === '/health';
      // Update checks are public reads (must work for signed-out users),
      // still covered by the per-IP limiter above.
      const isUpdateCheck = method === 'GET' && path === '/updates/check';
      // Phase 9.a accounts endpoints: unauthenticated by design (they ARE
      // the login flow), but under a stricter per-IP limit. The separate
      // admin gateway's POST /admin/login rides the same bucket (it is a
      // login flow too) plus its own stricter 5/min bucket below.
      const isAdminLoginRoute = method === 'POST' && path === '/admin/login';
      const isAuthRoute =
        method === 'POST' &&
        (path === '/auth/session' ||
          path === '/auth/refresh' ||
          path === '/auth/logout' ||
          path === '/admin/login');
      // Admin session endpoints: authenticated by admin JWT (requireAdmin),
      // NOT by the x-admin-key used for /admin/users/:id/plan.
      const isAdminSessionRoute =
        (method === 'GET' && path === '/admin/me') ||
        (method === 'POST' && (path === '/admin/logout' || path === '/admin/refresh'));
      // Phase 9.b admin plan toggle: authenticated via x-admin-key, not
      // Bearer, so it skips the Bearer auth block below (it keeps the
      // top-level per-IP limiter, which already ran for this route).
      const adminPlanMatch = method === 'POST' ? ADMIN_PLAN_ROUTE_RE.exec(path) : null;
      const adminSigninLogClearMatch =
        method === 'POST' ? ADMIN_SIGNIN_LOG_CLEAR_RE.exec(path) : null;
      const isAdminRoute = adminPlanMatch !== null || adminSigninLogClearMatch !== null;

      // 1. IP allowlist.
      if (!ipAllowed(ip, this.config.ipAllowlist)) {
        status = 403;
        throw new ApiError(403, 'ip_not_allowed', 'client IP is not allowlisted');
      }

      // S8: per-IP backstop (before auth — even unauthenticated floods count).
      // Skipped for /health so load-balancer probes never trip it.
      if (!isHealth && !this.ipLimiter.tryAdmit(ip)) {
        status = 429;
        res.setHeader('Retry-After', '60');
        throw new ApiError(429, 'ip_rate_limited', 'too many requests from this IP');
      }

      // Phase 9.a: /auth/* gets its own stricter bucket (20 req/min/IP).
      if (isAuthRoute && !this.authIpLimiter.tryAdmit(ip)) {
        status = 429;
        res.setHeader('Retry-After', '60');
        throw new ApiError(429, 'auth_rate_limited', 'too many auth attempts from this IP');
      }

      // Separate admin gateway: dedicated 5 req/min/IP bucket on POST
      // /admin/login — brute-force backstop on top of the /auth/* bucket.
      if (isAdminLoginRoute && !this.adminLoginIpLimiter.tryAdmit(ip)) {
        status = 429;
        res.setHeader('Retry-After', '60');
        throw new ApiError(429, 'admin_login_rate_limited', 'too many admin login attempts from this IP');
      }

      // 2/3. Auth (skipped for /health, /updates/check, and /auth/*) + body.
      // Modes, tried in order: GitHub OAuth token (per-user free tier),
      // static gateway API key, then Sunday session JWT (Phase 9.a).
      // A valid credential of any mode always wins.
      let key: { id: string } | undefined;
      let socialIdentity: SocialIdentity | undefined;
      let sessionUserId: string | undefined;
      // Separate admin gateway: admin JWTs (iss=sunday-admin, role=admin)
      // authenticate here and bypass user-level restrictions below
      // (account-switch limit is structural — /admin/login never invokes it;
      // daily quota is skipped explicitly at the quota check).
      let isAdminSession = false;
      let adminEmail: string | undefined;
      if (!isHealth && !isUpdateCheck && !isAuthRoute && !isAdminRoute) {
        const secret = KeyStore.extractBearer(req.headers.authorization);

        // Admin sessions first: distinct issuer + role claim, verified by
        // AdminService (stateful — revoked sessions fail here).
        const admin = secret ? this.adminAuth.verifyAdminToken(secret) : undefined;
        if (admin) {
          isAdminSession = true;
          adminEmail = admin.email;
          // Namespaced key id; the email hash (not the email) reaches logs.
          key = { id: `admin:${emailHash(admin.email).slice(0, 8)}` };
          keyId = key.id;
        } else if (this.config.socialAuth && secret) {
          socialIdentity = (await this.social.verify(secret)) ?? undefined;
        }

        if (admin) {
          // Admin session: authenticated — skip all other modes below.
        } else if (socialIdentity) {
          // Per-user identity: rate-limit key becomes the namespaced user id.
          key = { id: socialIdentity.key };
          // M2: log only the namespaced key, never the label (Google emails /
          // Microsoft UPNs are PII and don't belong in log stores).
          keyId = socialIdentity.key;
        } else {
          const found = this.keys.verify(secret);
          if (found) {
            key = found;
            keyId = keyFingerprint(found.secret);
          } else {
            // Phase 9.a: Sunday session JWT. Namespaced like social ids so a
            // user id can never collide with a gateway API key id.
            const userId = secret ? this.accounts.verifySessionToken(secret) : undefined;
            if (userId) {
              sessionUserId = userId;
              key = { id: `sess:${userId}` };
              keyId = key.id;
            } else {
              status = 401;
              keyId = secret ? 'invalid' : 'none';
              res.setHeader('WWW-Authenticate', 'Bearer');
              throw new ApiError(
                401,
                'unauthorized',
                this.config.socialAuth
                  ? 'valid social login token, Sunday session token, or gateway API key required'
                  : 'valid Bearer API key or Sunday session token required',
              );
            }
          }
        }
      }

      if (method === 'GET' && path === '/health') {
        status = 200;
        this.sendJson(res, 200, { ok: true, version: VERSION });
        return;
      }

      if (isUpdateCheck) {
        const query = (req.url ?? '').split('?')[1] ?? '';
        const params = new URLSearchParams(query);
        const platformParam = params.get('platform');
        const current = params.get('current') ?? '';
        const platform: UpdatePlatform | null =
          platformParam === 'win32' || platformParam === 'darwin' || platformParam === 'linux'
            ? platformParam
            : null;
        if (!platform || !current) {
          status = 400;
          throw new ApiError(
            400,
            'invalid_update_query',
            'query must include platform=win32|darwin|linux and current=<version>',
          );
        }
        // Optional channel=stable|beta. Defaults to stable, but auto-detects beta
        // from the client's current version (e.g. 1.0.0-beta.1 -> beta channel).
        const channelParam = params.get('channel');
        const channel: 'stable' | 'beta' =
          channelParam === 'beta' ? 'beta' : 'stable';
        const result = await this.updates.check(platform, current, channel);
        status = 200;
        this.sendJson(res, 200, result);
        return;
      }

      // Phase 9.a accounts endpoints (unauthenticated; per-IP limited above).
      if (isAuthRoute) {
        const body = await this.parseJsonBody(req);
        // Separate admin gateway: allowlist-gated OAuth login. Every attempt
        // (success and failure) is audit-logged by AdminService with the
        // email hashed — never plaintext.
        if (path === '/admin/login') {
          const idToken = typeof body.idToken === 'string' ? body.idToken : body.id_token;
          const result = await this.adminAuth.login(idToken, body.provider, ip);
          status = 200;
          this.sendJson(res, 200, result);
          return;
        }
        if (path === '/auth/session') {
          const created = await this.accounts.createSession(body.google_access_token, {
            machineId: typeof body.machine_id === 'string' ? body.machine_id : undefined,
          });
          status = 200;
          this.sendJson(res, 200, created);
          return;
        }
        if (path === '/auth/refresh') {
          const rotated = this.accounts.rotateRefreshToken(body.refresh_token);
          status = 200;
          this.sendJson(res, 200, rotated);
          return;
        }
        // path === '/auth/logout'
        this.accounts.logout(
          body.refresh_token,
          KeyStore.extractBearer(req.headers.authorization),
        );
        status = 200;
        this.sendJson(res, 200, { ok: true });
        return;
      }

      // Separate admin gateway: session endpoints. Authenticated by admin
      // JWT via requireAdmin (NOT by x-admin-key — that's the plan-toggle).
      // 401 when the Bearer token is not a live admin session.
      if (isAdminSessionRoute) {
        const bearer = KeyStore.extractBearer(req.headers.authorization);
        if (!isAdminSession) {
          status = 401;
          res.setHeader('WWW-Authenticate', 'Bearer');
          throw new ApiError(401, 'admin_unauthorized', 'valid admin session required');
        }
        const body = method === 'POST' ? await this.parseJsonBody(req) : {};
        if (path === '/admin/me') {
          status = 200;
          this.sendJson(res, 200, this.adminAuth.me(bearer));
          return;
        }
        if (path === '/admin/refresh') {
          const rotated = this.adminAuth.rotateAdminRefresh(body.refresh_token);
          status = 200;
          this.sendJson(res, 200, rotated);
          return;
        }
        // path === '/admin/logout' — revokes refresh token + access session.
        this.adminAuth.logoutAdmin(body.refresh_token, bearer);
        status = 200;
        this.sendJson(res, 200, { ok: true });
        return;
      }

      // Phase 9.b: requires a valid Sunday session JWT specifically (the
      // middleware also records which auth mode was used in sessionUserId).
      // Serves the full EntitlementsView computed from the user's plan
      // template. Top-level `plan` + `entitlements` are kept so Phase 9.a
      // clients keep working.
      if (method === 'GET' && path === '/me/entitlements') {
        if (!sessionUserId) {
          status = 401;
          throw new ApiError(401, 'unauthorized', 'valid Sunday session token required');
        }
        const user = this.accounts.getUser(sessionUserId);
        if (!user) {
          status = 404;
          throw new ApiError(404, 'unknown_user', 'no Sunday account for this session');
        }
        status = 200;
        this.sendJson(
          res,
          200,
          computeEntitlements(user.id, planOrBasic(user.plan, this.plans), this.plans),
        );
        return;
      }

      // Phase 9.b: admin plan toggle — for testing gating before billing
      // exists. NOT for production (single shared key, no audit trail, no
      // RBAC). Auth: `x-admin-key` header compared in constant time against
      // SUNDAY_ADMIN_KEY; an unset key fails closed (403 on every call).
      // The key is NEVER logged. Rate limiting comes from the top-level
      // per-IP limiter, which already admitted this request.
      if (adminPlanMatch || adminSigninLogClearMatch) {
        const configuredKey = this.config.adminKey;
        const presentedKey = req.headers['x-admin-key'];
        const keyOk =
          typeof configuredKey === 'string' &&
          configuredKey.length > 0 &&
          typeof presentedKey === 'string' &&
          safeEqual(presentedKey, configuredKey);
        if (!keyOk) {
          status = 403;
          throw new ApiError(
            403,
            configuredKey ? 'admin_forbidden' : 'admin_not_configured',
            configuredKey ? 'invalid admin key' : 'admin API is not configured',
          );
        }
        // Sub-route: POST /admin/signin-log/clear {machineId} — support tool
        // for clearing a machine's account-switch log.
        if (adminSigninLogClearMatch) {
          const body = await this.parseJsonBody(req);
          const machineId = body.machineId;
          if (typeof machineId !== 'string' || machineId.length === 0) {
            status = 400;
            throw new ApiError(400, 'missing_machine_id', 'body.machineId is required');
          }
          const removed = this.accounts.clearSigninLog(machineId);
          status = 200;
          this.sendJson(res, 200, { cleared: removed });
          return;
        }
        const body = await this.parseJsonBody(req);
        const plan = body.plan;
        if (plan !== 'basic' && plan !== 'smart' && plan !== 'pro') {
          status = 400;
          throw new ApiError(400, 'invalid_plan', 'body.plan must be one of basic|smart|pro');
        }
        const targetUserId = adminPlanMatch![1] as string;
        const updated = this.accounts.setUserPlan(targetUserId, plan);
        if (!updated) {
          status = 404;
          throw new ApiError(404, 'unknown_user', 'unknown user id');
        }
        status = 200;
        this.sendJson(
          res,
          200,
          computeEntitlements(updated.id, planOrBasic(updated.plan, this.plans), this.plans),
        );
        return;
      }

      // D2: usage dashboard. Session-auth only, like /me/entitlements — a
      // gateway API key is a shared operator credential and must not see
      // per-user metered data.
      if (method === 'GET' && path === '/me/usage') {
        if (!sessionUserId) {
          status = 401;
          throw new ApiError(401, 'unauthorized', 'valid Sunday session token required');
        }
        status = 200;
        // Metering is keyed by the same namespaced rate-limit key used in
        // recordUsage below (`sess:<userId>` for session auth).
        this.sendJson(res, 200, this.usage.snapshot(`sess:${sessionUserId}`));
        return;
      }

      // Engagement: today's quota with the streak bonus applied. The client
      // reports its local streak length (?streak_days=N); the bonus band sits
      // strictly above the base quota (v1 trusts the client; see streakBonus.ts).
      if (method === 'GET' && path === '/me/usage/today') {
        if (!sessionUserId) {
          status = 401;
          throw new ApiError(401, 'unauthorized', 'valid Sunday session token required');
        }
        const query = (req.url ?? '').split('?')[1] ?? '';
        const params = new URLSearchParams(query);
        const streakDays = parseStreakDays(params.get('streak_days'));
        const streakBonus = getStreakBonus(streakDays);
        const baseQuota = this.config.dailyQuota;
        const totalQuota = baseQuota + streakBonus;
        const userKey = `sess:${sessionUserId}`;
        const snap = this.usage.snapshot(userKey);
        const used = this.quota.usedToday(userKey);
        status = 200;
        this.sendJson(res, 200, {
          requests: snap.today.requests,
          tokens_in: snap.today.tokens_in,
          tokens_out: snap.today.tokens_out,
          base_requests: snap.today.base_requests ?? 0,
          bonus_requests: snap.today.bonus_requests ?? 0,
          streak_days: streakDays,
          streak_bonus: streakBonus,
          base_quota: baseQuota,
          total_quota: totalQuota,
          quota_remaining: Math.max(0, totalQuota - used),
          quota_reset_after_ms: this.quota.msUntilReset(),
        });
        return;
      }

      // D3: end-to-end encrypted session sync. Session-auth only. The blob
      // is stored VERBATIM — the server never decrypts it (see the security
      // contract in sync.ts). Size cap: 5 MiB.
      if (method === 'POST' && path === '/sync/sessions') {
        if (!sessionUserId) {
          status = 401;
          throw new ApiError(401, 'unauthorized', 'valid Sunday session token required');
        }
        const body = await this.parseJsonBody(req, MAX_SYNC_BLOB_BYTES + 1024);
        const blob = body.blob;
        const updatedAt = body.updated_at;
        if (typeof blob !== 'string' || blob.length === 0) {
          status = 400;
          throw new ApiError(400, 'invalid_sync_blob', 'body.blob must be a non-empty string');
        }
        if (Buffer.byteLength(blob, 'utf8') > MAX_SYNC_BLOB_BYTES) {
          status = 413;
          throw new ApiError(
            413,
            'sync_blob_too_large',
            `sync blob exceeds ${MAX_SYNC_BLOB_BYTES} bytes`,
          );
        }
        if (typeof updatedAt !== 'string' || updatedAt.length === 0 || updatedAt.length > 64) {
          status = 400;
          throw new ApiError(400, 'invalid_sync_blob', 'body.updated_at must be a short string');
        }
        await this.syncStore.save(sessionUserId, blob, updatedAt);
        status = 200;
        this.sendJson(res, 200, { ok: true, updated_at: updatedAt });
        return;
      }

      if (method === 'GET' && path === '/sync/sessions') {
        if (!sessionUserId) {
          status = 401;
          throw new ApiError(401, 'unauthorized', 'valid Sunday session token required');
        }
        const rec = await this.syncStore.load(sessionUserId);
        if (!rec) {
          status = 404;
          throw new ApiError(404, 'sync_not_found', 'no synced sessions for this user');
        }
        status = 200;
        this.sendJson(res, 200, { blob: rec.blob, updated_at: rec.updated_at });
        return;
      }

      // A1: async agent tasks. Auth required (identity = key.id, namespaced
      // like the social/session ids so key ids and user ids never collide).
      // The sundayd CloudTaskRunner claims queued tasks and posts results;
      // the IDE submits and polls. Tasks are strictly per-identity.
      const agentRoute = /^\/agent\/tasks(?:\/([A-Za-z0-9_-]{1,64})(?:\/(claim|result))?)?$/.exec(path);
      if (agentRoute) {
        if (!this.agentIpLimiter.tryAdmit(ip)) {
          status = 429;
          res.setHeader('Retry-After', '60');
          throw new ApiError(429, 'agent_rate_limited', 'too many agent-task requests from this IP');
        }
        const userId = key!.id;
        const taskId = agentRoute[1];
        const action = agentRoute[2];

        if (method === 'POST' && !taskId) {
          const body = await this.parseJsonBody(req);
          const problems = validateTaskInput(body.prompt, body.repo_context);
          if (problems.length) {
            status = 400;
            throw new ApiError(400, 'invalid_task', problems.join('; '));
          }
          const task = this.agentTasks.create(
            userId,
            String(body.prompt).trim(),
            typeof body.repo_context === 'string' ? body.repo_context : undefined,
          );
          status = 201;
          this.sendJson(res, 201, { task: publicTask(task) });
          return;
        }

        if (method === 'GET' && !taskId) {
          status = 200;
          this.sendJson(res, 200, {
            tasks: this.agentTasks.list(userId).map(publicTask),
          });
          return;
        }

        if (taskId && method === 'GET' && !action) {
          const task = this.agentTasks.get(userId, taskId);
          if (!task) {
            status = 404;
            throw new ApiError(404, 'task_not_found', 'unknown agent task');
          }
          status = 200;
          this.sendJson(res, 200, { task: publicTask(task) });
          return;
        }

        if (taskId && method === 'POST' && action === 'claim') {
          const task = this.agentTasks.claim(userId, taskId);
          if (!task) {
            status = 409;
            throw new ApiError(409, 'task_not_claimable', 'task does not exist, is not yours, or is not queued');
          }
          status = 200;
          this.sendJson(res, 200, { task: publicTask(task) });
          return;
        }

        if (taskId && method === 'POST' && action === 'result') {
          const body = await this.parseJsonBody(req);
          const hasResult = typeof body.result === 'string';
          const hasError = typeof body.error === 'string';
          if (!hasResult && !hasError) {
            status = 400;
            throw new ApiError(400, 'invalid_result', 'body must include result or error (string)');
          }
          const task = this.agentTasks.complete(userId, taskId, {
            ...(hasResult ? { result: body.result as string } : {}),
            ...(hasError ? { error: body.error as string } : {}),
          });
          if (!task) {
            status = 409;
            throw new ApiError(409, 'task_not_completable', 'task does not exist, is not yours, or is already terminal');
          }
          status = 200;
          this.sendJson(res, 200, { task: publicTask(task) });
          return;
        }

        status = 404;
        throw new ApiError(404, 'not_found', `unknown route: ${method} ${path}`);
      }

      if (method === 'GET' && path === '/v1/models') {
        const models = await this.registry.listModels().catch(() => []);
        status = 200;
        this.sendJson(res, 200, modelsListObject(models.map((m) => ({ id: m.id }))));
        return;
      }

      if (method === 'POST' && path === '/v1/chat/completions') {
        const raw = await this.readBody(req, this.config.maxBodyBytes);
        let parsed: unknown;
        try {
          parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
        } catch {
          status = 400;
          throw new ApiError(400, 'invalid_json', 'request body must be valid JSON');
        }

        // 4. Validation (also enforces the tools ban + model allowlist).
        const chatReq = parseChatRequest(parsed, {
          maxBodyBytes: this.config.maxBodyBytes,
          maxMessages: this.config.maxMessages,
          maxMessageChars: this.config.maxMessageChars,
          maxTokensCap: this.config.maxTokensCap,
          allowedModels: this.config.allowedModels,
        });
        model = chatReq.model;
        promptTokensEst = chatReq.promptTokensEst;

        // 4b. Daily free-tier quota (social-identified users only).
        // Admin sessions bypass explicitly (defense in depth — admin
        // tokens never produce a socialIdentity anyway).
        // Streak bonus: the client reports its local streak length via the
        // X-Sunday-Streak-Days header; the bonus band sits strictly above
        // the base quota (v1 trusts the client; see streakBonus.ts).
        if (socialIdentity && !isAdminSession) {
          const streakDays = parseStreakDays(req.headers['x-sunday-streak-days']);
          const streakBonus = getStreakBonus(streakDays);
          const q = this.quota.tryConsumeWithBonus(socialIdentity.key, streakBonus);
          quotaType = q.quotaType ?? 'base';
          res.setHeader('X-Quota-Limit', String(q.limit));
          res.setHeader('X-Quota-Base-Limit', String(this.config.dailyQuota));
          res.setHeader('X-Quota-Streak-Bonus', String(streakBonus));
          res.setHeader('X-Quota-Type', quotaType);
          res.setHeader('X-Quota-Remaining', String(q.remaining));
          if (!q.allowed) {
            status = 429;
            const retrySec = Math.max(1, Math.ceil(q.resetAfterMs / 1000));
            res.setHeader('Retry-After', String(retrySec));
            throw new ApiError(
              429,
              'quota_exceeded',
              `daily free-tier quota exhausted (${q.limit}/day${streakBonus > 0 ? ` incl. +${streakBonus} streak bonus` : ''}), resets in ${Math.ceil(retrySec / 60)}m`,
            );
          }
        }

        // 5. Rate limit (admitted only when both buckets have capacity).
        const decision = this.limiter.tryAdmit(key!.id, promptTokensEst);
        res.setHeader('X-RateLimit-Remaining-Requests', String(decision.remainingRequests));
        res.setHeader('X-RateLimit-Remaining-Tokens', String(decision.remainingTokens));
        if (!decision.allowed) {
          status = 429;
          const retrySec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
          res.setHeader('Retry-After', String(retrySec));
          throw new ApiError(429, 'rate_limited', `rate limit exceeded, retry after ${retrySec}s`);
        }

        // 6. Upstream call with timeout + client-disconnect abort.
        const controller = new AbortController();
        const onClose = (): void => controller.abort();
        req.on('close', onClose);
        const timeout = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);
        try {
          const routed = await this.router.chat({
            model: chatReq.model,
            messages: chatReq.messages,
            // tools: never forwarded — text chat only.
            temperature: chatReq.temperature,
            maxTokens: chatReq.maxTokens,
            signal: controller.signal,
          });

          if (chatReq.stream) {
            const streamedChars = await this.streamSse(res, chatReq.model, routed.stream, requestId);
            completionTokensEst = Math.max(1, Math.ceil(streamedChars / 4));
            this.recordUsage(key!.id, chatReq.model, promptTokensEst, completionTokensEst, quotaType);
          } else {
            const { text, finishReason } = await this.collectText(routed.stream);
            completionTokensEst = Math.max(1, Math.ceil(text.length / 4));
            status = 200;
            this.sendJson(res, 200, chatCompletionObject({
              model: chatReq.model,
              text,
              promptTokens: promptTokensEst,
              completionTokens: completionTokensEst,
              finishReason,
            }));
            this.recordUsage(key!.id, chatReq.model, promptTokensEst, completionTokensEst, quotaType);
          }
        } finally {
          clearTimeout(timeout);
          req.off('close', onClose);
        }
        return;
      }

      status = 404;
      throw new ApiError(404, 'not_found', `unknown route: ${method} ${path}`);
    } catch (err) {
      const { status: s, body } = errorBody(err);
      status = s;
      if (err instanceof ApiError) error = err.code;
      else if (err instanceof Error) error = 'internal';
      this.sendJson(res, s, body);
      if (s === 413) {
        // The request body may still be streaming (we paused it in
        // readBody). Close the socket once the 413 has flushed so the
        // unread body can't hold the connection open.
        res.once('finish', () => req.destroy());
      }
    } finally {
      this.audit.write({
        ...auditBase,
        keyId,
        model,
        status,
        latencyMs: Date.now() - startedMs,
        promptTokensEst,
        completionTokensEst,
        ...(error ? { error } : {}),
      });
    }
  }

  /** Consume the provider stream, keeping text only (tool calls dropped). */
  private async collectText(stream: AsyncIterable<ChatChunk>): Promise<{ text: string; finishReason: string }> {
    let text = '';
    let finishReason = 'stop';
    for await (const c of stream) {
      if (c.type === 'text-delta') text += c.delta;
      else if (c.type === 'done') finishReason = c.finishReason === 'tool_calls' ? 'stop' : c.finishReason;
      // 'tool-call' chunks are deliberately dropped: the hosted gateway
      // never executes tools.
    }
    return { text, finishReason };
  }

  private async streamSse(
    res: ServerResponse,
    model: string,
    stream: AsyncIterable<ChatChunk>,
    requestId: string,
  ): Promise<number> {
    const id = `chatcmpl-${requestId}`;
    let streamedChars = 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      for await (const c of stream) {
        if (c.type === 'text-delta') {
          streamedChars += c.delta.length;
          res.write(sseChunkObject({ model, id, delta: c.delta }));
        } else if (c.type === 'done') {
          const fr = c.finishReason === 'tool_calls' ? 'stop' : c.finishReason;
          res.write(sseChunkObject({ model, id, finishReason: fr }));
        }
        // tool-call chunks dropped (see collectText).
      }
      res.write('data: [DONE]\n\n');
    } finally {
      res.end();
    }
    return streamedChars;
  }

  /**
   * D2: feed the usage meter. Called for every completed chat completion
   * (streaming and non-streaming). Best-effort — metering must never break
   * response handling, so failures are swallowed.
   */
  private recordUsage(userKey: string, model: string, tokensIn: number, tokensOut: number, quotaType: QuotaType = 'base'): void {
    try {
      this.usage.record(userKey, model, tokensIn, tokensOut, Date.now(), quotaType);
    } catch {
      /* metering is advisory */
    }
  }
}
