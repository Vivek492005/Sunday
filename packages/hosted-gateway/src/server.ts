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
import { randomUUID } from 'node:crypto';
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
import { UpdateChecker, type UpdatePlatform } from './updates.js';
import { AccountsService, basicEntitlements } from './accounts.js';
import {
  ApiError,
  chatCompletionObject,
  errorBody,
  modelsListObject,
  parseChatRequest,
  sseChunkObject,
} from './openai-api.js';

const VERSION = '0.1.0';

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
  private readonly audit: AuditLog;
  private readonly router: Router;
  private readonly registry: ProviderRegistry;
  private readonly social: SocialVerifier;
  private readonly quota: DailyQuota;
  private readonly accounts: AccountsService;
  private readonly updates: UpdateChecker;
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
    this.audit = new AuditLog(config.auditLog);
    // S8: restrict the server registry to paid upstream providers only.
    // The default registry includes `sunday:` (self-loop burning quota) and
    // `ollama:` (connection-refused on Render) — neither makes sense here.
    this.registry = deps.registry ?? createDefaultRegistry(['openrouter', 'groq']);
    this.router = deps.router ?? new Router(this.registry, 'openrouter:meta-llama/llama-3.3-70b-instruct');
    this.social = new SocialVerifier(this.config.oauthProviders);
    this.quota = new DailyQuota(config.dailyQuota);
    this.accounts = new AccountsService(config.sessionSecret, {
      dataDir: deps.dataDir,
      fetchFn: deps.accountsFetch,
    });
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

  /** Read a JSON object body (empty body -> {}); throws 400 on invalid JSON. */
  private async parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await this.readBody(req, this.config.maxBodyBytes);
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
    let error: string | undefined;

    try {
      const isHealth = method === 'GET' && path === '/health';
      // Update checks are public reads (must work for signed-out users),
      // still covered by the per-IP limiter above.
      const isUpdateCheck = method === 'GET' && path === '/updates/check';
      // Phase 9.a accounts endpoints: unauthenticated by design (they ARE
      // the login flow), but under a stricter per-IP limit.
      const isAuthRoute =
        method === 'POST' &&
        (path === '/auth/session' || path === '/auth/refresh' || path === '/auth/logout');

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

      // 2/3. Auth (skipped for /health, /updates/check, and /auth/*) + body.
      // Modes, tried in order: GitHub OAuth token (per-user free tier),
      // static gateway API key, then Sunday session JWT (Phase 9.a).
      // A valid credential of any mode always wins.
      let key: { id: string } | undefined;
      let socialIdentity: SocialIdentity | undefined;
      let sessionUserId: string | undefined;
      if (!isHealth && !isUpdateCheck && !isAuthRoute) {
        const secret = KeyStore.extractBearer(req.headers.authorization);

        if (this.config.socialAuth && secret) {
          socialIdentity = (await this.social.verify(secret)) ?? undefined;
        }

        if (socialIdentity) {
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
        const result = await this.updates.check(platform, current);
        status = 200;
        this.sendJson(res, 200, result);
        return;
      }

      // Phase 9.a accounts endpoints (unauthenticated; per-IP limited above).
      if (isAuthRoute) {
        const body = await this.parseJsonBody(req);
        if (path === '/auth/session') {
          const created = await this.accounts.createSession(body.google_access_token);
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

      // Phase 9.a: requires a valid Sunday session JWT specifically (the
      // middleware also records which auth mode was used in sessionUserId).
      if (method === 'GET' && path === '/me/entitlements') {
        if (!sessionUserId) {
          status = 401;
          throw new ApiError(401, 'unauthorized', 'valid Sunday session token required');
        }
        status = 200;
        this.sendJson(res, 200, basicEntitlements());
        return;
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
        if (socialIdentity) {
          const q = this.quota.tryConsume(socialIdentity.key);
          res.setHeader('X-Quota-Limit', String(q.limit));
          res.setHeader('X-Quota-Remaining', String(q.remaining));
          if (!q.allowed) {
            status = 429;
            const retrySec = Math.max(1, Math.ceil(q.resetAfterMs / 1000));
            res.setHeader('Retry-After', String(retrySec));
            throw new ApiError(
              429,
              'quota_exceeded',
              `daily free-tier quota exhausted (${q.limit}/day), resets in ${Math.ceil(retrySec / 60)}m`,
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
            await this.streamSse(res, chatReq.model, routed.stream, requestId);
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
  ): Promise<void> {
    const id = `chatcmpl-${requestId}`;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      for await (const c of stream) {
        if (c.type === 'text-delta') {
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
  }
}
