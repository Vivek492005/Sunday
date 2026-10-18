/** Router policies (§10.5, Phase 3): ordered provider preference, per-provider
 *  model allowlists / retry / timeout budgets, and the visible Relay fallback. */

export type FailoverTrigger = 'rate-limit' | 'server-error';

export interface PerProviderPolicy {
  /** Bare model ids this provider may serve. Absent/empty = no restriction. */
  models?: string[];
  /** Max same-provider retries for a retryable failure before moving on. */
  maxRetries?: number;
  /** Per-attempt timeout in ms. Absent = no timeout. */
  timeoutMs?: number;
}

export interface RouterPolicyConfig {
  /** Provider ids in preference order. The first usable one wins. */
  order: string[];
  perProvider: Record<string, PerProviderPolicy>;
  failover: {
    enabled: boolean;
    on: FailoverTrigger[];
    /** P1-4: provider ids the user refuses to fail over TO. Requests pinned
     *  to an opted-out provider still work (explicit choice), but automatic
     *  relay will skip these. Set via SUNDAY_RELAY_FAILOVER_OPTOUT
     *  (comma-separated). */
    optOut?: string[];
  };
}

/** Metadata for a visible provider switch. This is surfaced on chat events —
 *  the Relay is never silent (§10.6). */
export interface RelayAttempt {
  from: string; // provider id we started on
  to: string; // provider id that served the request
  reason: FailoverTrigger;
}

// ---------------------------------------------------------------------------
// F3 — Honest Routing & Task-class Router
// ---------------------------------------------------------------------------

/**
 * Task class for routing. The router maps each class to a RoutePolicy whose
 * primary model fits the job: plan/architect → strong reasoning model,
 * edit/apply → fast cheap model, autocomplete → tiny model, verify →
 * an independent model (different family from the writer where possible).
 */
export type TaskClass =
  | 'plan'
  | 'architect'
  | 'edit'
  | 'apply'
  | 'autocomplete'
  | 'verify'
  | 'default'
  // F14 — local-first chat modes: Ask + Explain + Inline edit prefer the
  // user's own Ollama server first, with graceful cloud fallback.
  | 'ask'
  | 'explain'
  | 'inline-edit';

/** What the router may do when the primary model hits a limit/error. */
export type DowngradeMode =
  /** Ask the user first — NEVER switch providers/models without consent. */
  | 'ask'
  /** Legacy relay behaviour: switch automatically (still logged + visible). */
  | 'auto'
  /** Never switch: surface the original error. */
  | 'never';

/**
 * Per-task-class routing policy (F3). Model refs are "provider:model" or a
 * bare model id (resolved against the router's default model prefix).
 */
export interface RoutePolicy {
  taskClass: TaskClass;
  /** Preferred model ref, e.g. "openrouter:meta-llama/llama-3.3-70b-instruct". */
  primary: string;
  /** Ordered fallback model refs tried when the primary fails. */
  fallbacks: string[];
  downgrade: DowngradeMode;
}

/** Why the user is being asked about a downgrade. */
export type ConsentDecision = 'yes' | 'wait' | 'later';

/** A consent request emitted before ANY provider/model switch when
 *  `downgrade === 'ask'`. Rendered by the client (e.g. ext-agent modal):
 *  "Model A limit hit. Continue on B (est. quality ↓, cost ↓)?
 *   [Yes / Wait / Retry later]" + "always for this session" option. */
export interface DowngradeConsentRequest {
  taskClass: TaskClass;
  /** Model ref we are leaving, e.g. "openrouter:meta-llama/llama-3.3-70b-instruct". */
  from: string;
  /** Model ref we want to switch to. */
  to: string;
  reason: FailoverTrigger;
  /** Human-readable delta, e.g. "est. quality ↓, cost ↓". */
  qualityNote: string;
}

export interface ConsentResponse {
  decision: ConsentDecision;
  /** "always for this session": auto-yes future identical downgrades. */
  rememberSession?: boolean;
}

/**
 * Resolves a downgrade consent request. The gateway NEVER switches providers
 * or models under `downgrade === 'ask'` without this returning
 * `{ decision: 'yes' }` — no handler, a denied decision, or a timeout all
 * resolve to the safe default: pause (RoutingPausedError).
 */
export type ConsentHandler = (
  req: DowngradeConsentRequest,
) => Promise<ConsentResponse>;

/** Default consent timeout. Timeout → safe default = pause. */
export const DEFAULT_CONSENT_TIMEOUT_MS = 60_000;

/** A single provider attempt, for diagnostics. */
export interface AttemptRecord {
  providerId: string;
  ok: boolean;
  skipped?: 'cooldown' | 'model-not-allowed' | 'unknown-provider';
  error?: string;
}

/**
 * Resolve the ordered candidate provider ids for a request.
 * - An explicit `provider:` prefix pins the primary; the rest of `order`
 *   (minus the primary) are failover candidates when failover is enabled.
 * - A bare model id uses the full `order`.
 * Providers whose `models` allowlist excludes the bare model id are dropped.
 */
export function resolveCandidates(
  requestedProviderId: string | undefined,
  bareModel: string,
  policy: RouterPolicyConfig | undefined,
  knownIds: Set<string>,
): { primaryId: string; candidates: string[] } {
  if (!policy) {
    if (!requestedProviderId) throw new Error('router: no policy and no explicit provider in model ref');
    return { primaryId: requestedProviderId, candidates: [requestedProviderId] };
  }
  const allowed = (id: string): boolean => {
    const models = policy.perProvider[id]?.models;
    return !models?.length || models.includes(bareModel);
  };
  // P1-4: honor the failover opt-out list for automatic relay candidates.
  // An explicitly requested provider is never filtered (user's choice).
  const optedOut = new Set(policy.failover.optOut ?? []);
  if (requestedProviderId) {
    if (!knownIds.has(requestedProviderId)) {
      throw new Error(`unknown provider: ${requestedProviderId}`);
    }
    const rest = policy.failover.enabled
      ? policy.order.filter(
          (id) => id !== requestedProviderId && knownIds.has(id) && allowed(id) && !optedOut.has(id),
        )
      : [];
    return { primaryId: requestedProviderId, candidates: [requestedProviderId, ...rest] };
  }
  const ordered = policy.order.filter((id) => knownIds.has(id) && allowed(id) && !optedOut.has(id));
  if (ordered.length === 0) {
    throw new Error(
      `router: no provider in policy order can serve model '${bareModel}'`,
    );
  }
  return { primaryId: ordered[0], candidates: ordered };
}

/** Classify a provider failure for failover decisions. */
export function classifyFailure(err: unknown): FailoverTrigger | 'other' {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') {
    if (status === 429) return 'rate-limit';
    if (status >= 500 && status < 600) return 'server-error';
  }
  // Some providers surface rate limits without a numeric status on the error.
  const name = (err as Error)?.name ?? '';
  const msg = (err as Error)?.message ?? '';
  if (name === 'ProviderHttpError' && /429|rate.?limit|too many requests/i.test(msg)) {
    return 'rate-limit';
  }
  return 'other';
}
