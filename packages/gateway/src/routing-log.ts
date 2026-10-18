/**
 * F3 — Routing decision log + typed pause error.
 *
 * Every routing decision the Router makes is recorded here (100% coverage:
 * each chat() emits at least route-start and route-end/route-error). The
 * session log lets users audit exactly why a model was chosen or switched —
 * the core of "honest" routing.
 */
import type { ConsentDecision, FailoverTrigger, TaskClass } from './policies.js';

export type RoutingDecisionKind =
  | 'route-start'
  | 'attempt'
  | 'consent-request'
  | 'consent-response'
  | 'relay'
  | 'route-end'
  | 'route-error';

export interface RoutingLogEntry {
  seq: number;
  ts: string;
  kind: RoutingDecisionKind;
  taskClass: TaskClass;
  /** The model ref the caller asked for (or the policy primary). */
  requestedModel: string;
  /** "provider:model" ref of the primary candidate. */
  primary?: string;
  /** "provider:model" ref that served the request. */
  chosen?: string;
  providerId?: string;
  attempt?: number;
  ok?: boolean;
  skipped?: string;
  reason?: FailoverTrigger | string;
  error?: string;
  consent?: {
    from: string;
    to: string;
    /** Absent on `consent-request` entries (no answer yet). */
    decision?: ConsentDecision | 'timeout' | 'no-handler';
    remembered: boolean;
  };
  latencyMs?: number;
}

/** In-memory ring buffer of routing decisions. Not persisted — the caller
 *  (gateway server / sundayd) drains it into the session log. */
export class RoutingLog {
  private readonly buf: RoutingLogEntry[] = [];
  private seq = 0;

  constructor(private readonly cap = 500) {}

  record(e: Omit<RoutingLogEntry, 'seq' | 'ts'>): RoutingLogEntry {
    const entry: RoutingLogEntry = {
      ...e,
      seq: this.seq++,
      ts: new Date().toISOString(),
    };
    this.buf.push(entry);
    if (this.buf.length > this.cap) this.buf.shift();
    return entry;
  }

  entries(): RoutingLogEntry[] {
    return [...this.buf];
  }

  ofKind(kind: RoutingDecisionKind): RoutingLogEntry[] {
    return this.buf.filter((e) => e.kind === kind);
  }

  clear(): void {
    this.buf.length = 0;
  }
}

/**
 * Per-session consent memory for "always for this session". Keyed by
 * `taskClass:from→to` downgrade transitions the user already approved.
 * Owned by the caller (gateway server session, ext-agent) and passed into
 * the Router — never global, so one user's "always" can't leak to another.
 */
export class RoutingSession {
  private readonly remembered = new Map<string, true>();

  static key(taskClass: TaskClass, from: string, to: string): string {
    return `${taskClass}:${from}→${to}`;
  }

  remember(taskClass: TaskClass, from: string, to: string): void {
    this.remembered.set(RoutingSession.key(taskClass, from, to), true);
  }

  isRemembered(taskClass: TaskClass, from: string, to: string): boolean {
    return this.remembered.has(RoutingSession.key(taskClass, from, to));
  }

  clear(): void {
    this.remembered.clear();
  }
}

export type PauseReason =
  | 'consent-denied' // user picked Wait
  | 'retry-later' // user picked Retry later
  | 'consent-timeout' // no answer within the timeout
  | 'no-consent-handler'; // downgrade=ask but nobody can ask the user

/**
 * Thrown when routing pauses instead of switching models. The safe default
 * for `downgrade === 'ask'`: no handler, denied consent, or timeout all
 * land here — the provider/model is NEVER switched silently.
 */
export class RoutingPausedError extends Error {
  readonly code = 'ROUTING_PAUSED';
  readonly pauseReason: PauseReason;
  readonly taskClass: TaskClass;
  readonly from: string;
  readonly to: string;
  readonly trigger: FailoverTrigger;

  constructor(opts: {
    pauseReason: PauseReason;
    taskClass: TaskClass;
    from: string;
    to: string;
    trigger: FailoverTrigger;
    cause?: unknown;
  }) {
    super(
      `routing paused (${opts.pauseReason}): ${opts.from} hit ${opts.trigger}; ` +
        `declined to switch to ${opts.to} without consent`,
      { cause: opts.cause },
    );
    this.name = 'RoutingPausedError';
    this.pauseReason = opts.pauseReason;
    this.taskClass = opts.taskClass;
    this.from = opts.from;
    this.to = opts.to;
    this.trigger = opts.trigger;
  }
}
