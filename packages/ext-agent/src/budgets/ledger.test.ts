// Tests for budgets/ledger.ts — cost-per-successful-task counts only
// verifier-passing tasks.
import { describe, expect, it } from 'vitest';
import {
  TaskLedger,
  costPerSuccessfulTask,
  taskSuccessRate,
  type TaskRecord,
} from './ledger.js';

const rec = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  model: 'auto',
  requests: 10,
  success: true,
  at: Date.now(),
  ...over,
});

describe('costPerSuccessfulTask', () => {
  it('returns undefined with no successful tasks', () => {
    expect(costPerSuccessfulTask([])).toBeUndefined();
    expect(costPerSuccessfulTask([rec({ success: false })])).toBeUndefined();
  });

  it('averages only successful tasks', () => {
    const rs = [rec({ requests: 10 }), rec({ requests: 20 }), rec({ requests: 999, success: false })];
    expect(costPerSuccessfulTask(rs)).toBe(15);
  });

  it('ignores zero-request records', () => {
    expect(costPerSuccessfulTask([rec({ requests: 0 })])).toBeUndefined();
  });
});

describe('taskSuccessRate', () => {
  it('returns undefined when empty', () => {
    expect(taskSuccessRate([])).toBeUndefined();
  });
  it('computes the fraction', () => {
    expect(taskSuccessRate([rec(), rec({ success: false }), rec(), rec({ success: false })])).toBe(
      0.5,
    );
  });
});

describe('TaskLedger', () => {
  it('records and reports cost per success', () => {
    const l = new TaskLedger();
    l.record(rec({ requests: 8 }));
    l.record(rec({ requests: 12 }));
    l.record(rec({ requests: 100, success: false }));
    expect(l.costPerSuccessfulTask()).toBe(10);
    expect(l.successRate()).toBeCloseTo(2 / 3);
    expect(l.successfulCount()).toBe(2);
    expect(l.size()).toBe(3);
  });

  it('averageRequests feeds the estimator', () => {
    const l = new TaskLedger();
    expect(l.averageRequests()).toBeUndefined();
    l.record(rec({ requests: 10 }));
    l.record(rec({ requests: 30 }));
    expect(l.averageRequests()).toBe(20);
  });

  it('bounds memory by rolling off oldest records', () => {
    const l = new TaskLedger(3);
    for (let i = 0; i < 5; i++) l.record(rec({ requests: i + 1 }));
    expect(l.size()).toBe(3);
    // Oldest two rolled off; newest three remain (requests 3,4,5).
    expect(l.averageRequests()).toBe(4);
  });

  it('ignores malformed records', () => {
    const l = new TaskLedger();
    l.record({ id: 'x', model: 'm', requests: NaN, success: true, at: 0 });
    l.record({ id: 'x', model: 'm', requests: -1, success: true, at: 0 });
    expect(l.size()).toBe(0);
  });

  it('snapshot returns copies', () => {
    const l = new TaskLedger();
    l.record(rec({ requests: 7 }));
    const s = l.snapshot();
    s[0].requests = 999;
    expect(l.averageRequests()).toBe(7);
  });
});
