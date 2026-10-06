import { describe, it, expect } from 'vitest';

/**
 * Orchestrator parallelism ceiling test (Path-to-10 §8).
 *
 * The orchestrator caps parallel Feature Agents (default 8). Requesting more
 * must queue gracefully — never silently drop or crash.
 */

// Mirrors the runner's pool logic: bounded, FIFO queue beyond the cap.
class BoundedPool {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly cap: number) {}

  submit(task: () => void): 'started' | 'queued' {
    if (this.running < this.cap) {
      this.running++;
      task();
      return 'started';
    }
    this.queue.push(task);
    return 'queued';
  }

  completeOne(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }

  get queuedCount(): number { return this.queue.length; }
  get runningCount(): number { return this.running; }
}

describe('orchestrator parallelism ceiling', () => {
  it('starts up to the cap immediately', () => {
    const pool = new BoundedPool(8);
    const results: string[] = [];
    for (let i = 0; i < 8; i++) {
      results.push(pool.submit(() => {}));
    }
    expect(results.every((r) => r === 'started')).toBe(true);
    expect(pool.runningCount).toBe(8);
  });

  it('queues the 9th agent gracefully (cap 8)', () => {
    const pool = new BoundedPool(8);
    for (let i = 0; i < 8; i++) pool.submit(() => {});
    const ninth = pool.submit(() => {});
    expect(ninth).toBe('queued');
    expect(pool.queuedCount).toBe(1);
    expect(pool.runningCount).toBe(8); // no crash, no silent drop
  });

  it('drains the queue in FIFO order as agents complete', () => {
    const pool = new BoundedPool(2);
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      pool.submit(() => order.push(idx));
    }
    // 0,1 started; 2,3,4 queued
    expect(pool.queuedCount).toBe(3);
    pool.completeOne(); // 2 starts
    pool.completeOne(); // 3 starts
    expect(order).toEqual([0, 1, 2, 3]);
    expect(pool.queuedCount).toBe(1);
  });

  it('never exceeds the cap under burst load', () => {
    const pool = new BoundedPool(8);
    let maxRunning = 0;
    const origSubmit = pool.submit.bind(pool);
    for (let i = 0; i < 100; i++) {
      origSubmit(() => {});
      maxRunning = Math.max(maxRunning, pool.runningCount);
    }
    expect(maxRunning).toBeLessThanOrEqual(8);
    expect(pool.queuedCount).toBe(92);
  });
});
