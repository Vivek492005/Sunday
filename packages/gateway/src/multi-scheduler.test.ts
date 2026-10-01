// @sunday/gateway — MultiAgentScheduler tests.
//
// Deterministic via an injectable clock (`now`) plus vitest fake timers for
// the quota-resume path. No network, no real waiting.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter } from './scheduler.js';
import {
  ProviderRegistry,
  Router,
  MockChatProvider,
  type ChatRequest,
  type RouterPolicyConfig,
} from './index.js';
import {
  MultiAgentScheduler,
  PRIORITY_INTERACTIVE,
  PRIORITY_AGENT_STEP,
  PRIORITY_BACKGROUND,
  type SchedulerPriority,
} from './multi-scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Track grant order + waitedMs for a batch of acquires. */
function tracker(sched: MultiAgentScheduler, order: string[], waited: Record<string, number[]>) {
  return (id: string, p: SchedulerPriority = PRIORITY_AGENT_STEP) =>
    sched.acquire(id, p).then((g) => {
      order.push(id);
      (waited[id] ??= []).push(g.waitedMs);
      return g;
    });
}

describe('MultiAgentScheduler — fair queuing', () => {
  it('3 agents x 4 requests: all complete, round-robin order, bounded wait', async () => {
    const now = { t: 0 };
    const sched = new MultiAgentScheduler(
      { maxRequests: 1000, windowMs: 60_000 },
      { now: () => now.t },
    );
    const order: string[] = [];
    const waited: Record<string, number[]> = {};
    const track = tracker(sched, order, waited);

    const agents = ['a', 'b', 'c'];
    // Interleave enqueues so all three agents are pending at once —
    // sequential per-agent batches would (correctly) drain one agent first.
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) for (const id of agents) all.push(track(id));
    await Promise.all(all);

    expect(order).toHaveLength(12);
    // First rotation visits each agent exactly once, in first-seen order.
    expect(order.slice(0, 3)).toEqual(['a', 'b', 'c']);
    // No-starvation bound: while pending, an agent is served at least once
    // per k=3 grants → gap between its consecutive grants ≤ 3.
    for (const id of agents) {
      const idx = order.map((x, i) => (x === id ? i : -1)).filter((i) => i >= 0);
      expect(idx).toHaveLength(4);
      for (let i = 1; i < idx.length; i++) {
        expect(idx[i] - idx[i - 1]).toBeLessThanOrEqual(3);
      }
      expect(waited[id].every((w) => w === 0)).toBe(true); // no quota contention → no wait
    }
    sched.shutdown();
  });

  it('a quiet agent is not stuck behind a greedy agent’s queued requests', async () => {
    const now = { t: 0 };
    const sched = new MultiAgentScheduler(
      { maxRequests: 1000, windowMs: 60_000 },
      { now: () => now.t },
    );
    const order: string[] = [];
    const waited: Record<string, number[]> = {};
    const track = tracker(sched, order, waited);

    const p1 = track('greedy'); // granted immediately (only pending agent)
    const pq = track('quiet'); // arrives while greedy keeps queueing…
    const p2 = track('greedy');
    const p3 = track('greedy');
    const p4 = track('greedy');
    await Promise.all([p1, pq, p2, p3, p4]);

    // Round-robin serves quiet 2nd despite greedy's 3 queued requests.
    expect(order).toEqual(['greedy', 'quiet', 'greedy', 'greedy', 'greedy']);
    sched.shutdown();
  });

  it('a late-joining agent enters the rotation fairly', async () => {
    const now = { t: 0 };
    const sched = new MultiAgentScheduler(
      { maxRequests: 1000, windowMs: 60_000 },
      { now: () => now.t },
    );
    const order: string[] = [];
    const waited: Record<string, number[]> = {};
    const track = tracker(sched, order, waited);

    await Promise.all([track('a'), track('a')]); // a drains alone
    expect(order).toEqual(['a', 'a']);
    // b joins later with both pending: rotation alternates
    await Promise.all([track('a'), track('b'), track('a'), track('b')]);
    expect(order.slice(2)).toEqual(['a', 'b', 'a', 'b']);
    sched.shutdown();
  });
});

describe('MultiAgentScheduler — priorities', () => {
  it('P0 jumps ahead of queued P2 requests; P2 stays round-robin', async () => {
    vi.useFakeTimers();
    try {
      const now = { t: 0 };
      const sched = new MultiAgentScheduler(
        { maxRequests: 1, windowMs: 1000 },
        { now: () => now.t },
      );
      const order: string[] = [];
      const waited: Record<string, number[]> = {};
      const track = tracker(sched, order, waited);

      const holder = track('holder', PRIORITY_AGENT_STEP); // consumes the one slot
      const x = track('x', PRIORITY_BACKGROUND);
      const y = track('y', PRIORITY_BACKGROUND);
      const w = track('w', PRIORITY_INTERACTIVE); // P0 arrives last
      await holder;
      expect(order).toEqual(['holder']);

      // All three parked on quota exhaustion: exactly one resume timer, no spin.
      expect(vi.getTimerCount()).toBe(1);
      expect(sched.stats().totalPending).toBe(3);

      now.t += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      // P0 first (one slot per window) …
      expect(order).toEqual(['holder', 'w']);
      expect(waited['w']).toEqual([1000]);

      // … then P2 round-robin, one per window.
      now.t += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['holder', 'w', 'x']);
      expect(waited['x']).toEqual([2000]);

      now.t += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([x, y, w]);
      expect(order).toEqual(['holder', 'w', 'x', 'y']);
      expect(waited['y']).toEqual([3000]);
      sched.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MultiAgentScheduler — quota exhaustion', () => {
  it('exhausted pool: requests WAIT with retry-after and resume, never deadlock', async () => {
    vi.useFakeTimers();
    try {
      const now = { t: 0 };
      const sched = new MultiAgentScheduler(
        { maxRequests: 2, windowMs: 500 },
        { now: () => now.t },
      );
      const order: string[] = [];
      const waited: Record<string, number[]> = {};
      const track = tracker(sched, order, waited);

      await Promise.all([track('a'), track('b')]); // pool now exhausted
      let cDone = false;
      let dDone = false;
      const c = track('c').then((g) => { cDone = true; return g; });
      const d = track('d').then((g) => { dDone = true; return g; });
      await Promise.resolve();
      // Both parked — waiting, not failed, not spinning.
      expect(cDone).toBe(false);
      expect(dDone).toBe(false);
      expect(sched.stats().totalPending).toBe(2);
      expect(vi.getTimerCount()).toBe(1);

      // Window slides: everyone resumes.
      now.t += 500;
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([c, d]);
      expect(cDone).toBe(true);
      expect(dDone).toBe(true);
      expect(order).toEqual(['a', 'b', 'c', 'd']);
      expect(waited['c'][0]).toBe(500);
      expect(waited['d'][0]).toBe(500);
      expect(sched.stats().totalPending).toBe(0);
      sched.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares the wrapped RateLimiter pool (external consumption counts)', async () => {
    vi.useFakeTimers();
    try {
      const now = { t: 0 };
      const pool = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
      const sched = new MultiAgentScheduler(pool, {
        now: () => now.t,
        providerId: 'openrouter',
        model: 'm',
      });
      // Slot consumed directly through the pool…
      expect(pool.acquire('openrouter', 'm', now.t)).toEqual({ ok: true });
      let granted = false;
      const p = sched.acquire('a', PRIORITY_AGENT_STEP).then((g) => {
        granted = true;
        return g;
      });
      await Promise.resolve();
      expect(granted).toBe(false); // …so the scheduler waits on the same budget
      now.t += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(granted).toBe(true);
      sched.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MultiAgentScheduler — stats and ETA', () => {
  it('stats() reports pending, grants, waits and releases per agent', async () => {
    const now = { t: 0 };
    const sched = new MultiAgentScheduler(
      { maxRequests: 10, windowMs: 60_000 },
      { now: () => now.t },
    );
    await Promise.all([
      sched.acquire('a1', PRIORITY_INTERACTIVE),
      sched.acquire('a1', PRIORITY_INTERACTIVE),
      sched.acquire('a2', PRIORITY_BACKGROUND),
    ]);
    sched.release('a1');

    const s = sched.stats();
    const a1 = s.agents.find((a) => a.agentId === 'a1')!;
    expect(a1.acquired).toBe(2);
    expect(a1.released).toBe(1);
    expect(a1.pending).toBe(0);
    expect(a1.avgWaitedMs).toBe(0);
    const a2 = s.agents.find((a) => a.agentId === 'a2')!;
    expect(a2.acquired).toBe(1);
    expect(s.totalPending).toBe(0);
    expect(s.quota).toEqual({ maxRequests: 10, windowMs: 60_000 });
    sched.shutdown();
  });

  it('etaMs is finite and monotonic with data, Infinity without, 0 for no work', () => {
    const now = { t: 0 };
    const sched = new MultiAgentScheduler(
      { maxRequests: 100, windowMs: 60_000 },
      { now: () => now.t, throughputWindowMs: 10_000 },
    );
    expect(sched.etaMs('a', 5)).toBe(Number.POSITIVE_INFINITY);

    // 4 completions, one per second → 0.4 req/s.
    for (let i = 0; i < 4; i++) {
      sched.release('a');
      now.t += 1000;
    }
    expect(sched.etaMs('a', 8)).toBe(20_000);
    expect(sched.etaMs('a', 4)).toBe(10_000);
    expect(sched.etaMs('a', 8)).toBeGreaterThan(sched.etaMs('a', 4)); // monotonic
    expect(sched.etaMs('a', 0)).toBe(0);
    expect(sched.etaMs('a', -3)).toBe(0);

    // Stale throughput expires out of the window → Infinity again.
    now.t += 10_000;
    expect(sched.etaMs('a', 8)).toBe(Number.POSITIVE_INFINITY);
    sched.shutdown();
  });
});

describe('Router + MultiAgentScheduler integration', () => {
  const policy: RouterPolicyConfig = {
    order: ['mock'],
    perProvider: {},
    failover: { enabled: false, on: [] },
  };

  function chatReq(agent?: { id: string; priority?: SchedulerPriority }): ChatRequest {
    return {
      model: 'mock:model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ...(agent ? { agent } : {}),
    };
  }

  async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const chunk of stream) void chunk;
  }

  it('agent-context requests are fair-queued through the scheduler; others use the legacy path', async () => {
    const now = { t: 0 };
    const pool = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });
    const sched = new MultiAgentScheduler(pool, { now: () => now.t });
    const registry = new ProviderRegistry();
    registry.register(new MockChatProvider({ id: 'mock' }));
    const router = new Router(registry, 'mock:model', policy, undefined, sched);

    // With agent context → scheduler grants a slot, stream-end releases it.
    const r1 = await router.chat(chatReq({ id: 'unit-a', priority: PRIORITY_AGENT_STEP }));
    await drain(r1.stream);
    const afterAgent = sched.stats().agents.find((a) => a.agentId === 'unit-a');
    expect(afterAgent?.acquired).toBe(1);
    expect(afterAgent?.released).toBe(1);

    // Without agent context → legacy limiter path; scheduler untouched.
    const r2 = await router.chat(chatReq());
    await drain(r2.stream);
    expect(sched.stats().agents.find((a) => a.agentId === 'unit-a')?.acquired).toBe(1);
    sched.shutdown();
  });

  it('no scheduler configured: routing behaviour is exactly the legacy path', async () => {
    const registry = new ProviderRegistry();
    registry.register(new MockChatProvider({ id: 'mock' }));
    const router = new Router(registry, 'mock:model', policy);
    // Even with agent context on the request, no scheduler → legacy path, no crash.
    const r = await router.chat(chatReq({ id: 'unit-a' }));
    await drain(r.stream);
    expect(r.attempts).toEqual([{ providerId: 'mock', ok: true }]);
  });
});
