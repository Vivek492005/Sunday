/** Multi-agent fair scheduler (§9.9, Parallel Agents phase).
 *
 *  Wraps the existing {@link RateLimiter} as the SHARED quota pool and adds
 *  per-agent fair queuing on top of it:
 *
 *  - **Priority classes**: P0 user-visible interactive > P1 agent steps >
 *    P2 sub-agents/background. A higher class is always served first.
 *  - **Fair queuing**: within a priority class, grants rotate round-robin
 *    across agent ids that have pending requests. An agent with pending work
 *    is therefore guaranteed a slot within at most (k-1) other grants, where
 *    k is the number of agents with pending requests in its class — no
 *    starvation, no matter how aggressively another agent re-queues.
 *  - **Quota exhaustion**: when the shared pool is exhausted, requests WAIT
 *    (parked, with a resume scheduled for the pool's `retryAfterMs`) instead
 *    of failing or spinning. They resume automatically when the window frees
 *    a slot — never a deadlock, never a busy loop.
 *  - **ETA estimates**: per-agent throughput is tracked over a sliding
 *    window of completed requests; `etaMs(agentId, remaining)` estimates how
 *    long `remaining` more requests will take.
 *
 *  The clock (`now`) is injectable so tests can drive the scheduler with
 *  fake time deterministically. The quota pool key defaults to `*:*` (one
 *  global budget); pass `providerId`/`model` to scope it to a route.
 */

import { RateLimiter, DEFAULT_RATE_LIMIT, type RateLimitConfig } from './scheduler.js';

/** Priority classes. Lower number = served first. */
export type SchedulerPriority = 0 | 1 | 2;
/** P0: user-visible interactive traffic (chat turns, ghost text). */
export const PRIORITY_INTERACTIVE: SchedulerPriority = 0;
/** P1: agent steps (feature-agent / verifier model calls). */
export const PRIORITY_AGENT_STEP: SchedulerPriority = 1;
/** P2: sub-agents and background work (indexing, prefetch). */
export const PRIORITY_BACKGROUND: SchedulerPriority = 2;

export interface MultiAgentSchedulerOptions {
  /** Quota-pool key: provider id. Default `'*'` (one shared budget). */
  providerId?: string;
  /** Quota-pool key: model id. Default `'*'` (one shared budget). */
  model?: string;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Sliding window for throughput/ETA tracking. Default 60_000 ms. */
  throughputWindowMs?: number;
  /**
   * Quota description for `stats()` reporting, when wrapping an
   * externally-built pool whose config this scheduler cannot see.
   * (When the scheduler builds the pool from a `RateLimitConfig`, that
   * config is reported automatically.)
   */
  quota?: RateLimitConfig;
}

/** Resolution of `acquire`: how long this request waited for its slot. */
export interface AcquireGrant {
  waitedMs: number;
}

export interface AgentSchedulerStats {
  agentId: string;
  /** Requests currently queued for this agent. */
  pending: number;
  /** Slots granted to this agent (lifetime). */
  acquired: number;
  /** Slots released by this agent (lifetime). */
  released: number;
  /** Total ms spent waiting across all grants. */
  totalWaitedMs: number;
  /** Mean ms waited per grant (0 when nothing acquired yet). */
  avgWaitedMs: number;
}

export interface SchedulerStats {
  agents: AgentSchedulerStats[];
  totalPending: number;
  /** Quota the pool was built with; undefined when wrapping an external
   *  pool and no `quota` hint was supplied. */
  quota: { maxRequests: number; windowMs: number } | undefined;
}

interface Waiter {
  agentId: string;
  priority: SchedulerPriority;
  startedAt: number;
  resolve: (grant: AcquireGrant) => void;
}

/** One priority lane: per-agent FIFOs plus a round-robin cursor. */
interface PriorityLane {
  queues: Map<string, Waiter[]>;
  /** Agent ids in first-seen order; the cursor rotates over this. */
  order: string[];
  cursor: number;
}

function newLane(): PriorityLane {
  return { queues: new Map(), order: [], cursor: 0 };
}

export class MultiAgentScheduler {
  /** The shared quota pool this scheduler grants slots from. */
  readonly pool: RateLimiter;

  private readonly providerId: string;
  private readonly model: string;
  private readonly now: () => number;
  private readonly throughputWindowMs: number;
  private readonly quota: RateLimitConfig | undefined;

  private readonly lanes: PriorityLane[] = [newLane(), newLane(), newLane()];
  private pumping = false;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly granted = new Map<string, { acquired: number; totalWaitedMs: number }>();
  private readonly releasedCount = new Map<string, number>();
  private readonly completions = new Map<string, number[]>();

  constructor(pool?: RateLimiter | RateLimitConfig, opts: MultiAgentSchedulerOptions = {}) {
    this.pool = pool instanceof RateLimiter ? pool : new RateLimiter(pool ?? DEFAULT_RATE_LIMIT);
    this.quota = pool instanceof RateLimiter ? opts.quota : { ...(pool ?? DEFAULT_RATE_LIMIT) };
    this.providerId = opts.providerId ?? '*';
    this.model = opts.model ?? '*';
    this.now = opts.now ?? Date.now;
    this.throughputWindowMs = opts.throughputWindowMs ?? 60_000;
  }

  /**
   * Request a quota slot for `agentId`. Resolves with `{ waitedMs }` when the
   * slot is granted — immediately when quota and fairness allow, otherwise
   * after waiting in the fair queue (including across quota-exhaustion
   * pauses). Higher priority classes are served first; within a class,
   * agents rotate round-robin so no agent starves.
   */
  acquire(agentId: string, priority: SchedulerPriority = PRIORITY_AGENT_STEP): Promise<AcquireGrant> {
    const lane = this.lanes[priority];
    let q = lane.queues.get(agentId);
    if (!q) {
      q = [];
      lane.queues.set(agentId, q);
      lane.order.push(agentId);
    }
    const startedAt = this.now();
    const p = new Promise<AcquireGrant>((resolve) => {
      q!.push({ agentId, priority, startedAt, resolve });
    });
    this.pump();
    return p;
  }

  /**
   * Hand a slot back. Purely informational for throughput/ETA tracking —
   * windowed quota slots are time-based, not reference-counted — so calling
   * it is optional but recommended (the Router does it when a stream ends).
   */
  release(agentId: string): void {
    this.releasedCount.set(agentId, (this.releasedCount.get(agentId) ?? 0) + 1);
    const now = this.now();
    let arr = this.completions.get(agentId);
    if (!arr) {
      arr = [];
      this.completions.set(agentId, arr);
    }
    arr.push(now);
    const cutoff = now - this.throughputWindowMs;
    while (arr.length > 0 && arr[0] <= cutoff) arr.shift();
  }

  /** Park a provider+model in cooldown (e.g. after a 429); extends, never shortens. */
  noteRateLimited(retryAfterMs: number, now: number = this.now()): void {
    this.pool.noteRateLimited(this.providerId, this.model, retryAfterMs, now);
  }

  /** Snapshot of per-agent queue depth, grants, waits and releases. */
  stats(): SchedulerStats {
    const agents: AgentSchedulerStats[] = [];
    const ids = new Set<string>([
      ...this.granted.keys(),
      ...this.releasedCount.keys(),
      ...this.lanes.flatMap((l) => l.order),
    ]);
    for (const agentId of ids) {
      const g = this.granted.get(agentId);
      agents.push({
        agentId,
        pending: this.pendingFor(agentId),
        acquired: g?.acquired ?? 0,
        released: this.releasedCount.get(agentId) ?? 0,
        totalWaitedMs: g?.totalWaitedMs ?? 0,
        avgWaitedMs: g && g.acquired > 0 ? g.totalWaitedMs / g.acquired : 0,
      });
    }
    agents.sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
    return {
      agents,
      totalPending: agents.reduce((s, a) => s + a.pending, 0),
      quota: this.quota ? { ...this.quota } : undefined,
    };
  }

  /**
   * Estimated ms until `remainingRequests` more requests for `agentId`
   * complete, from this agent's recent throughput (sliding window).
   * Returns `Infinity` when there is no throughput data yet, `0` for
   * non-positive `remainingRequests`. Monotonic non-decreasing in
   * `remainingRequests`.
   */
  etaMs(agentId: string, remainingRequests: number): number {
    if (!(remainingRequests > 0)) return 0;
    const now = this.now();
    const cutoff = now - this.throughputWindowMs;
    const recent = (this.completions.get(agentId) ?? []).filter((t) => t > cutoff);
    if (recent.length === 0) return Number.POSITIVE_INFINITY;
    const ratePerMs = recent.length / this.throughputWindowMs;
    return remainingRequests / ratePerMs;
  }

  /** Clear any pending quota-resume timer (test/daemon-shutdown hygiene). */
  shutdown(): void {
    if (this.resumeTimer !== undefined) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = undefined;
    }
  }

  private pendingFor(agentId: string): number {
    let n = 0;
    for (const lane of this.lanes) n += lane.queues.get(agentId)?.length ?? 0;
    return n;
  }

  /**
   * Highest-priority pending waiter, round-robin within its class. This only
   * PEEKS — it never dequeues and never moves the cursor. The caller advances
   * the cursor after the quota check succeeds, so a denied pool never costs
   * anyone their turn in the rotation.
   */
  private peekNext():
    | { lane: PriorityLane; agentId: string; waiter: Waiter; orderIdx: number }
    | undefined {
    for (const lane of this.lanes) {
      const n = lane.order.length;
      for (let i = 0; i < n; i++) {
        const idx = (lane.cursor + i) % n;
        const agentId = lane.order[idx];
        const q = lane.queues.get(agentId);
        if (q !== undefined && q.length > 0) {
          return { lane, agentId, waiter: q[0], orderIdx: idx };
        }
      }
    }
    return undefined;
  }

  /**
   * Grant loop: serve waiters in priority/round-robin order while the shared
   * pool has quota. On exhaustion, park everyone and schedule a resume for
   * the pool's `retryAfterMs` — waiters simply wait; nothing fails, nothing
   * spins, nothing deadlocks.
   */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const next = this.peekNext();
        if (!next) {
          this.clearResumeTimer();
          return;
        }
        const gate = this.pool.acquire(this.providerId, this.model, this.now());
        if (!gate.ok) {
          this.scheduleResume(gate.retryAfterMs);
          return;
        }
        const q = next.lane.queues.get(next.agentId)!;
        q.shift();
        next.lane.cursor = (next.orderIdx + 1) % next.lane.order.length;
        const waitedMs = Math.max(0, this.now() - next.waiter.startedAt);
        const g = this.granted.get(next.agentId) ?? { acquired: 0, totalWaitedMs: 0 };
        g.acquired += 1;
        g.totalWaitedMs += waitedMs;
        this.granted.set(next.agentId, g);
        next.waiter.resolve({ waitedMs });
      }
    } finally {
      this.pumping = false;
    }
  }

  private scheduleResume(retryAfterMs: number): void {
    this.clearResumeTimer();
    const delay = Math.max(0, Math.ceil(retryAfterMs));
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      this.pump();
    }, delay);
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer !== undefined) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = undefined;
    }
  }
}
