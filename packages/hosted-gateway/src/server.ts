/**
 * @sunday/hosted-gateway — HTTP server with abuse controls.
 *
 * Middleware order per request:
 *   1. IP allowlist (403 when the operator configured one and the IP misses)
 *   2. Body read with a hard byte cap (413 on overflow)
 *   3. API key auth — Bearer, constant-time (401; skipped for /health)
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
import { KeyRateLimiter } from './rate-limit.js';
import { AuditLog } from './audit.js';
import { ipAllowed, normalizeIp } from './ip-allowlist.js';
import { GitHubVerifier, type GitHubIdentity } from './github-auth.js';
import { DailyQuota } from './quota.js';
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
}

export class HostedGatewayServer {
  private readonly keys: KeyStore;
  private readonly limiter: KeyRateLimiter;
  private readonly audit: AuditLog;
  private readonly router: Router;
  private readonly registry: ProviderRegistry;
  private readonly github: GitHubVerifier;
  private readonly quota: DailyQuota;
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
    this.audit = new AuditLog(config.auditLog);
    this.registry = deps.registry ?? createDefaultRegistry();
    this.router = deps.router ?? new Router(this.registry, 'openrouter:meta-llama/llama-3.3-70b-instruct');
    this.github = new GitHubVerifier();
    this.quota = new DailyQuota(config.dailyQuota);
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
      // 1. IP allowlist.
      if (!ipAllowed(ip, this.config.ipAllowlist)) {
        status = 403;
        throw new ApiError(403, 'ip_not_allowed', 'client IP is not allowlisted');
      }

      // 2/3. Auth (skipped for /health) + body.
      // Two modes: GitHub OAuth token (per-user free tier) or static
      // gateway API key (operator/testing). GitHub mode is tried first
      // when enabled; a valid GitHub token always wins.
      const isHealth = method === 'GET' && path === '/health';
      let key: { id: string } | undefined;
      let ghIdentity: GitHubIdentity | undefined;
      if (!isHealth) {
        const secret = KeyStore.extractBearer(req.headers.authorization);

        if (this.config.githubAuth && secret) {
          ghIdentity = (await this.github.verify(secret)) ?? undefined;
        }

        if (ghIdentity) {
          // Per-user identity: rate-limit key becomes the GitHub user id.
          key = { id: `gh:${ghIdentity.id}` };
          keyId = `gh:${ghIdentity.id} (${ghIdentity.login})`;
        } else {
          const found = this.keys.verify(secret);
          if (!found) {
            status = 401;
            keyId = secret ? 'invalid' : 'none';
            res.setHeader('WWW-Authenticate', 'Bearer');
            throw new ApiError(
              401,
              'unauthorized',
              this.config.githubAuth
                ? 'valid GitHub token or gateway API key required'
                : 'valid Bearer API key required',
            );
          }
          key = found;
          keyId = keyFingerprint(found.secret);
        }
      }

      if (method === 'GET' && path === '/health') {
        status = 200;
        this.sendJson(res, 200, { ok: true, version: VERSION });
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

        // 4b. Daily free-tier quota (GitHub-identified users only).
        if (ghIdentity) {
          const q = this.quota.tryConsume(ghIdentity.id);
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
