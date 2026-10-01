import type { ProviderRegistry } from './registry.js';
import type { ChatChunk, ChatProvider, ChatRequest } from './types.js';
import { ProviderHttpError } from './openai-compatible.js';
import { RateLimiter, getRetryAfterMs, DEFAULT_RATE_LIMIT } from './scheduler.js';
import { MultiAgentScheduler, PRIORITY_AGENT_STEP } from './multi-scheduler.js';
import {
  classifyFailure,
  resolveCandidates,
  type AttemptRecord,
  type RelayAttempt,
  type RouterPolicyConfig,
} from './policies.js';

/** Router (§10.5). Phase 1: resolve "provider:model" refs (or a bare id
 *  against the default provider). Phase 3: routing policies, the rate-limit
 *  scheduler, and the visible Relay fallback. */
export interface RouteRequest {
  model?: string;
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

  constructor(
    private registry: ProviderRegistry,
    private defaultModel = 'openrouter:meta-llama/llama-3.3-70b-instruct',
    private policy?: RouterPolicyConfig,
    limiter?: RateLimiter,
    scheduler?: MultiAgentScheduler,
  ) {
    // A limiter is only meaningful with a policy (failover needs an order).
    // When a MultiAgentScheduler is supplied it wraps the shared pool, so
    // the router falls back to the scheduler's pool as its limiter.
    this.scheduler = scheduler;
    this.limiter = limiter ?? scheduler?.pool ?? (policy ? new RateLimiter(DEFAULT_RATE_LIMIT) : undefined);
  }

  route(req: RouteRequest = {}): RouteResult {
    const raw = req.model ?? this.defaultModel;
    const { providerId, model } = parseModelRef(raw, this.defaultModel);
    return { provider: this.registry.get(providerId), model };
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
    const i = req.model.indexOf(':');
    const explicitProviderId = i > 0 ? req.model.slice(0, i) : undefined;
    const bareModel = i > 0 ? req.model.slice(i + 1) : req.model;

    let primaryId: string;
    let candidates: string[];
    if (!this.policy) {
      // Legacy behaviour: resolve exactly like route().
      const parsed = parseModelRef(req.model, this.defaultModel);
      primaryId = parsed.providerId;
      candidates = [parsed.providerId];
    } else {
      ({ primaryId, candidates } = resolveCandidates(
        explicitProviderId,
        bareModel,
        this.policy,
        new Set(this.registry.ids()),
      ));
    }

    const attempts: AttemptRecord[] = [];
    let relayReason: RelayAttempt['reason'] | undefined;
    let lastError: unknown;

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

    for (const pid of candidates) {
      const provider = this.registry.get(pid);
      const perProvider = this.policy?.perProvider[pid];
      const maxAttempts = 1 + Math.max(0, perProvider?.maxRetries ?? 0);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (!releaseSlot && this.limiter) {
          const gate = this.limiter.acquire(pid, bareModel);
          if (!gate.ok) {
            attempts.push({
              providerId: pid,
              ok: false,
              skipped: 'cooldown',
              error: `cooling down, retry in ${gate.retryAfterMs}ms`,
            });
            relayReason ??= 'rate-limit';
            break; // don't spin retries against a parked provider
          }
        }
        try {
          const stream = provider.chat({
            ...req,
            model: bareModel,
            signal: combineSignal(req.signal, perProvider?.timeoutMs),
          });
          // Await the first chunk: an HTTP-level failure (429/5xx) throws
          // here, before any output exists to duplicate.
          const it = stream[Symbol.asyncIterator]();
          const first = await it.next();
          attempts.push({ providerId: pid, ok: true });
          const relay: RelayAttempt | undefined =
            pid === primaryId
              ? undefined
              : { from: primaryId, to: pid, reason: relayReason ?? 'rate-limit' };
          const out = releaseSlot ? trackRelease(prepend(first, it), releaseSlot) : prepend(first, it);
          return { provider, model: bareModel, stream: out, relay, attempts };
        } catch (err) {
          lastError = err;
          const kind = classifyFailure(err);
          if (kind === 'rate-limit') {
            const retryAfter =
              err instanceof ProviderHttpError ? getRetryAfterMs(err.headers) : undefined;
            if (releaseSlot) this.scheduler!.noteRateLimited(retryAfter ?? DEFAULT_429_COOLDOWN_MS);
            else this.limiter?.noteRateLimited(pid, bareModel, retryAfter ?? DEFAULT_429_COOLDOWN_MS);
          }
          attempts.push({ providerId: pid, ok: false, error: (err as Error)?.message });
          const failover = this.policy?.failover;
          const retryable =
            !!failover?.enabled && kind !== 'other' && failover.on.includes(kind);
          if (retryable) {
            relayReason ??= kind;
            continue; // next attempt / next provider
          }
          releaseSlot?.();
          throw err;
        }
      }
    }

    releaseSlot?.();
    if (lastError) throw lastError;
    throw new Error(
      `router: all providers unavailable for model '${bareModel}' ` +
        `(${attempts.map((a) => `${a.providerId}:${a.skipped ?? 'failed'}`).join(', ')})`,
    );
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
