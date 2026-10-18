import type { ProviderRegistry } from './registry.js';
import type { ChatChunk, ChatProvider, ChatRequest } from './types.js';
import { ProviderHttpError } from './openai-compatible.js';
import { RateLimiter, getRetryAfterMs, DEFAULT_RATE_LIMIT } from './scheduler.js';
import { MultiAgentScheduler, PRIORITY_AGENT_STEP } from './multi-scheduler.js';
import {
  classifyFailure,
  resolveCandidates,
  DEFAULT_CONSENT_TIMEOUT_MS,
  type AttemptRecord,
  type ConsentHandler,
  type ConsentResponse,
  type DowngradeConsentRequest,
  type DowngradeMode,
  type FailoverTrigger,
  type RelayAttempt,
  type RoutePolicy,
  type RouterPolicyConfig,
  type TaskClass,
} from './policies.js';
import { policyForTaskClass, qualityNote } from './models.js';
import { LocalOnlyUnavailableError } from './local-chat.js';
import {
  RoutingLog,
  RoutingPausedError,
  RoutingSession,
} from './routing-log.js';

/** Router (§10.5). Phase 1: resolve "provider:model" refs (or a bare id
 *  against the default provider). Phase 3: routing policies, the rate-limit
 *  scheduler, and the visible Relay fallback. */
export interface RouteRequest {
  model?: string;
  /** F3: when routePolicies are configured, the matching policy's primary
   *  model is used instead of `model`. */
  taskClass?: TaskClass;
}

/** A single resolved routing candidate: provider + the bare model it serves.
 *  F3 policies allow fallbacks to be *different models*, not just different
 *  providers serving the same model. */
export interface ResolvedCandidate {
  providerId: string;
  /** Bare provider-side model id. */
  model: string;
  /** "provider:model" ref, for logs and consent prompts. */
  ref: string;
}

/** F3 options for honest routing. All optional — absent, the Router behaves
 *  exactly as before (legacy policy routing, auto relay). */
export interface RouterOptions {
  /** Per-task-class routing policies. */
  routePolicies?: RoutePolicy[];
  /** Consent UI hook for `downgrade === 'ask'`. Absent → safe default = pause. */
  consentHandler?: ConsentHandler;
  /** Per-session "always for this session" memory. Absent → ephemeral. */
  session?: RoutingSession;
  /** How long to wait for consent before pausing. */
  consentTimeoutMs?: number;
  /** Decision log. A fresh one is created when absent — decisions are
   *  always recorded (100% coverage). */
  routingLog?: RoutingLog;
}

export interface RouteResult {
  provider: ChatProvider;
  /** Bare provider-side model id (prefix stripped). */
  model: string;
}

/** Result of a routed chat call. `relay` is present whenever the request was
 *  served by a provider other than the preferred one — the Relay is visible,
 *  never silent (§10.6). */
export interface RoutedChat {
  provider: ChatProvider;
  /** Bare provider-side model id (prefix stripped). */
  model: string;
  stream: AsyncIterable<ChatChunk>;
  relay?: RelayAttempt;
  attempts: AttemptRecord[];
}

export function parseModelRef(
  ref: string,
  fallback: string,
): { providerId: string; model: string } {
  const i = ref.indexOf(':');
  if (i > 0) return { providerId: ref.slice(0, i), model: ref.slice(i + 1) };
  const d = fallback.indexOf(':');
  return { providerId: fallback.slice(0, d), model: ref };
}

/** Cooldown applied on a 429 that carries no usable Retry-After. */
export const DEFAULT_429_COOLDOWN_MS = 60_000;

export class Router {
  private readonly limiter: RateLimiter | undefined;
  private readonly scheduler: MultiAgentScheduler | undefined;
  private readonly options: RouterOptions;
  /** Every routing decision is recorded here — 100% coverage. */
  readonly routingLog: RoutingLog;

  constructor(
    private registry: ProviderRegistry,
    private defaultModel = 'sunday:meta-llama/llama-3.3-70b-instruct',
    private policy?: RouterPolicyConfig,
    limiter?: RateLimiter,
    scheduler?: MultiAgentScheduler,
    options: RouterOptions = {},
  ) {
    // A limiter is only meaningful with a policy (failover needs an order).
    // When a MultiAgentScheduler is supplied it wraps the shared pool, so
    // the router falls back to the scheduler's pool as its limiter.
    this.scheduler = scheduler;
    this.limiter = limiter ?? scheduler?.pool ?? (policy ? new RateLimiter(DEFAULT_RATE_LIMIT) : undefined);
    this.options = options;
    this.routingLog = options.routingLog ?? new RoutingLog();
  }

  route(req: RouteRequest = {}): RouteResult {
    // F3: a matching task-class policy overrides the model ref.
    const taskClass = req.taskClass ?? 'default';
    const routePolicy = policyForTaskClass(this.options.routePolicies, taskClass);
    if (routePolicy) {
      const first = this.resolvePolicyCandidates(routePolicy)[0];
      return { provider: this.registry.get(first.providerId), model: first.model };
    }
    const raw = req.model ?? this.defaultModel;
    const { providerId, model } = parseModelRef(raw, this.defaultModel);
    return { provider: this.registry.get(providerId), model };
  }

  /**
   * Resolve a RoutePolicy's model refs to provider+model candidates.
   * Unknown primary providers are a config error (fail fast); unknown
   * fallback providers are skipped.
   */
  private resolvePolicyCandidates(policy: RoutePolicy): ResolvedCandidate[] {
    const known = new Set(this.registry.ids());
    const out: ResolvedCandidate[] = [];
    for (const ref of [policy.primary, ...policy.fallbacks]) {
      const { providerId, model } = parseModelRef(ref, this.defaultModel);
      if (!known.has(providerId)) {
        if (ref === policy.primary) {
          throw new Error(
            `router: unknown provider '${providerId}' in route policy for task class '${policy.taskClass}'`,
          );
        }
        continue;
      }
      const allowlist = this.policy?.perProvider[providerId]?.models;
      if (allowlist?.length && !allowlist.includes(model)) continue;
      out.push({ providerId, model, ref: `${providerId}:${model}` });
    }
    if (out.length === 0) {
      throw new Error(
        `router: no provider in route policy for task class '${policy.taskClass}' can serve`,
      );
    }
    return out;
  }

  /**
   * F3 honest-routing gate. Called before the router leaves one candidate
   * for another after a failure.
   *
   * - `downgrade: 'auto'` → proceed (legacy visible relay, still logged).
   * - `downgrade: 'never'` → return 'throw-original': the caller's error
   *   surfaces, no fallback is attempted.
   * - `downgrade: 'ask'` → consult session memory, then the consent handler
   *   (with timeout). 'yes' proceeds; anything else — denied, retry-later,
   *   no handler, or timeout — throws RoutingPausedError. The provider/model
   *   is NEVER switched without explicit consent.
   */
  private async downgradeGate(args: {
    taskClass: TaskClass;
    requestedModel: string;
    from: string;
    to: string;
    reason: FailoverTrigger;
    mode: DowngradeMode;
    signal?: AbortSignal;
  }): Promise<'proceed' | 'throw-original'> {
    const { taskClass, requestedModel, from, to, reason, mode, signal } = args;
    if (mode === 'never') {
      this.routingLog.record({
        kind: 'route-error',
        taskClass,
        requestedModel,
        primary: from,
        reason: `downgrade=never: refusing switch ${from} → ${to}`,
      });
      return 'throw-original';
    }
    if (mode === 'auto') return 'proceed';

    // mode === 'ask'
    const session = this.options.session;
    if (session?.isRemembered(taskClass, from, to)) {
      this.routingLog.record({
        kind: 'consent-response',
        taskClass,
        requestedModel,
        primary: from,
        consent: { from, to, decision: 'yes', remembered: true },
      });
      return 'proceed';
    }

    const handler: ConsentHandler | undefined = this.options.consentHandler;
    const consentReq: DowngradeConsentRequest = {
      taskClass,
      from,
      to,
      reason,
      qualityNote: qualityNote(bareOf(from), bareOf(to)),
    };
    this.routingLog.record({
      kind: 'consent-request',
      taskClass,
      requestedModel,
      primary: from,
      consent: { from, to, remembered: false },
    });

    if (!handler) {
      this.routingLog.record({
        kind: 'consent-response',
        taskClass,
        requestedModel,
        primary: from,
        consent: { from, to, decision: 'no-handler', remembered: false },
      });
      throw new RoutingPausedError({
        pauseReason: 'no-consent-handler',
        taskClass,
        from,
        to,
        trigger: reason,
      });
    }

    const timeoutMs = this.options.consentTimeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;
    let decision: 'yes' | 'wait' | 'later';
    let rememberSession = false;
    try {
      const resp = await awaitConsent(handler, consentReq, timeoutMs, signal);
      decision = resp.decision;
      rememberSession = !!resp.rememberSession;
    } catch (err) {
      if (err instanceof ConsentTimeoutError) {
        this.routingLog.record({
          kind: 'consent-response',
          taskClass,
          requestedModel,
          primary: from,
          consent: { from, to, decision: 'timeout', remembered: false },
        });
        throw new RoutingPausedError({
          pauseReason: 'consent-timeout',
          taskClass,
          from,
          to,
          trigger: reason,
        });
      }
      throw err; // abort / handler error propagates
    }

    this.routingLog.record({
      kind: 'consent-response',
      taskClass,
      requestedModel,
      primary: from,
      consent: { from, to, decision, remembered: rememberSession },
    });

    if (decision === 'yes') {
      if (rememberSession) session?.remember(taskClass, from, to);
      return 'proceed';
    }
    throw new RoutingPausedError({
      pauseReason: decision === 'later' ? 'retry-later' : 'consent-denied',
      taskClass,
      from,
      to,
      trigger: reason,
    });
  }

  /**
   * Route a chat request through the policy: pick the first usable provider
   * in `order`, start its stream, and — on a retryable failure (429, or 5xx
   * when the policy opts in) — fail over to the next candidate.
   *
   * Failover only happens *before* the first chunk is produced: the first
   * `next()` on the provider stream is awaited here, so an HTTP-level 429/5xx
   * relays cleanly instead of tearing a half-rendered turn. A failure
   * mid-stream surfaces as a stream error (the turn cannot be re-run
   * elsewhere without duplicating output).
   */
  async chat(req: ChatRequest): Promise<RoutedChat> {
    const t0 = Date.now();
    const taskClass: TaskClass = req.taskClass ?? 'default';
    const routePolicy = policyForTaskClass(this.options.routePolicies, taskClass);
    let downgradeMode: DowngradeMode = routePolicy?.downgrade ?? 'auto';

    // Resolve candidates. F3 policies carry per-candidate models (fallbacks
    // may be *different models*); the legacy path keeps one bare model
    // across providers — behaviour unchanged when no policies configured.
    let candidates: ResolvedCandidate[];
    let primaryRef: string;
    if (routePolicy) {
      candidates = this.resolvePolicyCandidates(routePolicy);
      primaryRef = candidates[0].ref;
    } else {
      const i = req.model.indexOf(':');
      const explicitProviderId = i > 0 ? req.model.slice(0, i) : undefined;
      const bareModel = i > 0 ? req.model.slice(i + 1) : req.model;
      let primaryId: string;
      let ids: string[];
      if (!this.policy) {
        // Legacy behaviour: resolve exactly like route().
        const parsed = parseModelRef(req.model, this.defaultModel);
        primaryId = parsed.providerId;
        ids = [parsed.providerId];
      } else {
        ({ primaryId, candidates: ids } = resolveCandidates(
          explicitProviderId,
          bareModel,
          this.policy,
          new Set(this.registry.ids()),
        ));
      }
      candidates = ids.map((providerId) => ({
        providerId,
        model: bareModel,
        ref: `${providerId}:${bareModel}`,
      }));
      primaryRef = `${primaryId}:${bareModel}`;
    }

    this.routingLog.record({
      kind: 'route-start',
      taskClass,
      requestedModel: req.model,
      primary: primaryRef,
      reason: `downgrade=${downgradeMode}${req.privacy === 'local-only' ? ', privacy=local-only' : ''}`,
    });

    // F14 — privacy enforcement: 'local-only' pins the request to the
    // ollama provider. No cloud fallback exists by construction: the
    // candidate list contains only ollama, and the downgrade gate is
    // locked to 'never' so a failure surfaces instead of relaying.
    // (attempt bookkeeping is declared just below; the privacy branch
    // throws before any attempt is recorded.)
    const attempts: AttemptRecord[] = [];
    let relayReason: RelayAttempt['reason'] | undefined;
    let lastError: unknown;
    let failedRef: string | undefined;
    if (req.privacy === 'local-only') {
      const hasOllama = this.registry.ids().includes('ollama');
      candidates = hasOllama
        ? candidates.filter((c) => c.providerId === 'ollama')
        : [];
      if (candidates.length === 0) {
        const err = new LocalOnlyUnavailableError(
          `local-only request cannot be served: no ollama provider in the routing candidates for '${primaryRef}' (task class '${taskClass}'). ` +
            `Start Ollama with \`ollama serve\` or drop privacy='local-only'.`,
        );
        this.routingLog.record({
          kind: 'route-error',
          taskClass,
          requestedModel: req.model,
          primary: primaryRef,
          error: err.message,
          reason: 'privacy=local-only',
          latencyMs: Date.now() - t0,
        });
        throw err;
      }
      primaryRef = candidates[0].ref;
      downgradeMode = 'never';
    }

    // F14 — unavailable-primary skip: a provider that advertises a cheap
    // liveness check (Ollama's local /api/tags) and reports unavailable is
    // skipped before any attempt, so local-first task classes degrade to
    // their cloud fallbacks instead of failing the request. Only applies
    // when leaving the primary is allowed (downgrade !== 'never').
    if (downgradeMode !== 'never' && candidates.length > 1) {
      const primaryProvider = this.registry.get(candidates[0].providerId);
      if (typeof primaryProvider.isAvailable === 'function') {
        let available = true;
        try {
          available = await primaryProvider.isAvailable();
        } catch {
          available = false;
        }
        if (!available) {
          attempts.push({
            providerId: candidates[0].providerId,
            ok: false,
            error: 'provider unavailable (local daemon not running), skipping to fallback',
          });
          this.routingLog.record({
            kind: 'attempt',
            taskClass,
            requestedModel: req.model,
            primary: primaryRef,
            chosen: candidates[0].ref,
            providerId: candidates[0].providerId,
            ok: false,
            error: 'provider unavailable (local daemon not running), skipping to fallback',
          });
          relayReason = 'server-error';
          failedRef = primaryRef;
          lastError = new Error(
            `primary provider ${candidates[0].providerId} unavailable, trying fallback`,
          );
          candidates = candidates.slice(1);
          primaryRef = candidates[0].ref;
        }
      }
    }

    // Parallel-agents fair scheduling: one fair-queued slot from the shared
    // pool covers the whole call (failover candidates share it). Without an
    // agent context the legacy per-candidate limiter path below runs, so
    // single-agent behaviour is unchanged.
    const agentCtx = req.agent?.id ? req.agent : undefined;
    let releaseSlot: (() => void) | undefined;
    if (this.scheduler && agentCtx) {
      await this.scheduler.acquire(agentCtx.id, agentCtx.priority ?? PRIORITY_AGENT_STEP);
      releaseSlot = () => this.scheduler!.release(agentCtx.id);
    }

    const logAttempt = (
      cand: ResolvedCandidate,
      rec: Omit<AttemptRecord, 'providerId'>,
    ): void => {
      attempts.push({ providerId: cand.providerId, ...rec });
      this.routingLog.record({
        kind: 'attempt',
        taskClass,
        requestedModel: req.model,
        primary: primaryRef,
        chosen: cand.ref,
        providerId: cand.providerId,
        ok: rec.ok,
        skipped: rec.skipped,
        error: rec.error,
      });
    };

    try {
      for (let ci = 0; ci < candidates.length; ci++) {
        const cand = candidates[ci];
        if (ci > 0) {
          // Leaving the primary (or a prior fallback) after a failure:
          // the F3 honest-routing gate. 'ask' NEVER switches without consent.
          const gate = await this.downgradeGate({
            taskClass,
            requestedModel: req.model,
            from: failedRef ?? primaryRef,
            to: cand.ref,
            reason: relayReason ?? 'rate-limit',
            mode: downgradeMode,
            signal: req.signal,
          });
          if (gate === 'throw-original') {
            throw (
              lastError ??
              new Error(
                `router: downgrade=never, primary ${primaryRef} unavailable and no fallback allowed`,
              )
            );
          }
        }
        const provider = this.registry.get(cand.providerId);
        const perProvider = this.policy?.perProvider[cand.providerId];
        const maxAttempts = 1 + Math.max(0, perProvider?.maxRetries ?? 0);
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (!releaseSlot && this.limiter) {
            const gate = this.limiter.acquire(cand.providerId, cand.model);
            if (!gate.ok) {
              logAttempt(cand, {
                ok: false,
                skipped: 'cooldown',
                error: `cooling down, retry in ${gate.retryAfterMs}ms`,
              });
              relayReason ??= 'rate-limit';
              failedRef = cand.ref;
              lastError ??= new Error(
                `provider ${cand.providerId} cooling down, retry in ${gate.retryAfterMs}ms`,
              );
              break; // don't spin retries against a parked provider
            }
          }
          try {
            const stream = provider.chat({
              ...req,
              model: cand.model,
              signal: combineSignal(req.signal, perProvider?.timeoutMs),
            });
            // Await the first chunk: an HTTP-level failure (429/5xx) throws
            // here, before any output exists to duplicate.
            const it = stream[Symbol.asyncIterator]();
            const first = await it.next();
            logAttempt(cand, { ok: true });
            const relay: RelayAttempt | undefined =
              cand.ref === primaryRef
                ? undefined
                : {
                    from: primaryRef.slice(0, primaryRef.indexOf(':')),
                    to: cand.providerId,
                    reason: relayReason ?? 'rate-limit',
                  };
            // P1-4: never silent — log every automatic provider switch.
            if (relay) {
              console.warn(
                `[sunday gateway] relay failover: ${relay.from} -> ${relay.to} (reason: ${relay.reason})`,
              );
              this.routingLog.record({
                kind: 'relay',
                taskClass,
                requestedModel: req.model,
                primary: primaryRef,
                chosen: cand.ref,
                providerId: cand.providerId,
                reason: relay.reason,
              });
            }
            const out = releaseSlot
              ? trackRelease(prepend(first, it), releaseSlot)
              : prepend(first, it);
            this.routingLog.record({
              kind: 'route-end',
              taskClass,
              requestedModel: req.model,
              primary: primaryRef,
              chosen: cand.ref,
              providerId: cand.providerId,
              latencyMs: Date.now() - t0,
            });
            return { provider, model: cand.model, stream: out, relay, attempts };
          } catch (err) {
            lastError = err;
            failedRef = cand.ref;
            const kind = classifyFailure(err);
            if (kind === 'rate-limit') {
              const retryAfter =
                err instanceof ProviderHttpError ? getRetryAfterMs(err.headers) : undefined;
              if (releaseSlot)
                this.scheduler!.noteRateLimited(retryAfter ?? DEFAULT_429_COOLDOWN_MS);
              else this.limiter?.noteRateLimited(cand.providerId, cand.model, retryAfter ?? DEFAULT_429_COOLDOWN_MS);
            }
            logAttempt(cand, { ok: false, error: (err as Error)?.message });
            const failover = this.policy?.failover;
            const retryable =
              !!failover?.enabled && kind !== 'other' && failover.on.includes(kind);
            if (retryable) {
              relayReason ??= kind;
              continue; // next attempt / next provider
            }
            throw err;
          }
        }
      }

      if (lastError) throw lastError;
      throw new Error(
        `router: all providers unavailable for '${primaryRef}' ` +
          `(${attempts.map((a) => `${a.providerId}:${a.skipped ?? 'failed'}`).join(', ')})`,
      );
    } catch (err) {
      // 100% decision coverage: every chat() ends with route-end or route-error.
      this.routingLog.record({
        kind: 'route-error',
        taskClass,
        requestedModel: req.model,
        primary: primaryRef,
        error: (err as Error)?.message,
        reason: err instanceof RoutingPausedError ? `paused:${err.pauseReason}` : undefined,
        latencyMs: Date.now() - t0,
      });
      releaseSlot?.();
      throw err;
    }
  }
}

/** Re-emit a peeked first chunk followed by the rest of the iterator. */
async function* prepend(
  first: IteratorResult<ChatChunk>,
  it: AsyncIterator<ChatChunk>,
): AsyncGenerator<ChatChunk> {
  if (!first.done) yield first.value;
  for (;;) {
    const n = await it.next();
    if (n.done) return;
    yield n.value;
  }
}

/**
 * Wrap a stream so `onDone` runs exactly once when the consumer finishes,
 * errors, or abandons iteration (scheduler slot release for throughput/ETA).
 */
async function* trackRelease(
  stream: AsyncIterable<ChatChunk>,
  onDone: () => void,
): AsyncGenerator<ChatChunk> {
  try {
    yield* stream;
  } finally {
    onDone();
  }
}

/** Bare model id from a "provider:model" ref. */
function bareOf(ref: string): string {
  const i = ref.indexOf(':');
  return i > 0 ? ref.slice(i + 1) : ref;
}

/** Sentinel: the consent handler did not answer in time. */
class ConsentTimeoutError extends Error {
  constructor() {
    super('consent timed out');
    this.name = 'ConsentTimeoutError';
  }
}

/**
 * Await a consent decision with a timeout and abort-signal support.
 * Timeout → ConsentTimeoutError (caller maps to pause). Abort → the
 * signal's reason propagates (caller is cancelling; not a routing decision).
 */
function awaitConsent(
  handler: ConsentHandler,
  req: DowngradeConsentRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ConsentResponse> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new ConsentTimeoutError());
    }, timeoutMs);
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    };
    const cleanup = (): void => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    handler(req).then(
      (resp) => {
        cleanup();
        resolve(resp);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

/** Merge an optional per-provider timeout with the caller's abort signal. */
function combineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined || !(timeoutMs > 0)) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any.call(AbortSignal, [signal, timeout]);
  const ctrl = new AbortController();
  const onAbort = (): void => {
    if (!ctrl.signal.aborted) ctrl.abort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  timeout.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}
