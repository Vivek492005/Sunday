// Tests for budgets/budgetStore.ts — soft warn once, hard pause once,
// continue +N resumes, reset clears.
import { describe, expect, it } from 'vitest';
import {
  BudgetTracker,
  readBudgetConfig,
  saveBudgetConfig,
} from './budgetStore.js';

describe('BudgetTracker', () => {
  it('emits soft-warning once when the soft limit is crossed', () => {
    const t = new BudgetTracker({ day: { soft: 5 } });
    expect(t.recordSpend(4)).toEqual([]);
    const events = t.recordSpend(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'soft-warning', scope: 'day', spent: 5, limit: 5 });
    // Second crossing does not re-fire.
    expect(t.recordSpend(1)).toEqual([]);
  });

  it('emits hard-pause once and reports isPausedAny', () => {
    const t = new BudgetTracker({ task: { hard: 3 } });
    t.recordSpend(2);
    expect(t.isPausedAny()).toBe(false);
    const events = t.recordSpend(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'hard-pause', scope: 'task', spent: 3, limit: 3 });
    expect(t.isPaused('task')).toBe(true);
    expect(t.isPausedAny()).toBe(true);
    expect(t.pausedScopes()).toEqual(['task']);
    expect(t.recordSpend(1)).toEqual([]); // no double pause
  });

  it('hard takes precedence over soft when both crossed at once', () => {
    const t = new BudgetTracker({ day: { soft: 5, hard: 5 } });
    const events = t.recordSpend(5);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('hard-pause');
  });

  it('tracks each scope independently', () => {
    const t = new BudgetTracker({ task: { hard: 2 }, day: { hard: 100 } });
    t.recordSpend(2);
    expect(t.isPaused('task')).toBe(true);
    expect(t.isPaused('day')).toBe(false);
    expect(t.getSpent('day')).toBe(2);
  });

  it('continueAllowance clears the pause and extends the hard limit', () => {
    const t = new BudgetTracker({ task: { hard: 3 } });
    t.recordSpend(3);
    expect(t.isPaused('task')).toBe(true);
    t.continueAllowance('task', 10);
    expect(t.isPaused('task')).toBe(false);
    expect(t.hardLimit('task')).toBe(13);
    // Spend up to the extended limit without pausing again.
    expect(t.recordSpend(9)).toEqual([]);
    const events = t.recordSpend(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'hard-pause', limit: 13 });
  });

  it('continueAllowance ignores non-positive input', () => {
    const t = new BudgetTracker({ task: { hard: 3 } });
    t.recordSpend(3);
    t.continueAllowance('task', 0);
    t.continueAllowance('task', -5);
    expect(t.isPaused('task')).toBe(true);
    expect(t.hardLimit('task')).toBe(3);
  });

  it('reset clears spend, warn and pause state', () => {
    const t = new BudgetTracker({ task: { soft: 1, hard: 2 } });
    t.recordSpend(2);
    expect(t.isPaused('task')).toBe(true);
    t.reset('task');
    expect(t.isPaused('task')).toBe(false);
    expect(t.getSpent('task')).toBe(0);
    // Warn fires again after reset.
    const events = t.recordSpend(1);
    expect(events[0].type).toBe('soft-warning');
  });

  it('unlimited scopes never emit', () => {
    const t = new BudgetTracker({});
    expect(t.recordSpend(1000)).toEqual([]);
    expect(t.isPausedAny()).toBe(false);
  });

  it('recordSpend ignores non-positive counts', () => {
    const t = new BudgetTracker({ day: { soft: 1 } });
    expect(t.recordSpend(0)).toEqual([]);
    expect(t.recordSpend(-2)).toEqual([]);
    expect(t.getSpent('day')).toBe(0);
  });
});

describe('readBudgetConfig / saveBudgetConfig', () => {
  const memStore = () => {
    const m = new Map<string, unknown>();
    return {
      get: <T>(k: string) => m.get(k) as T | undefined,
      update: async (k: string, v: unknown) => {
        m.set(k, v);
      },
    };
  };

  it('round-trips a valid config', async () => {
    const s = memStore();
    await saveBudgetConfig(s, { day: { soft: 150, hard: 200 }, task: { hard: 30 } });
    expect(readBudgetConfig(s)).toEqual({ day: { soft: 150, hard: 200 }, task: { hard: 30 } });
  });

  it('returns {} for missing or invalid data', () => {
    expect(readBudgetConfig(memStore())).toEqual({});
    const bad = memStore();
    void bad.update('sunday.budgets.config.v1', { day: 'nope' });
    expect(readBudgetConfig(bad)).toEqual({});
  });

  it('drops non-positive limits', () => {
    const s = memStore();
    void s.update('sunday.budgets.config.v1', { day: { soft: -5, hard: 0 } });
    expect(readBudgetConfig(s)).toEqual({});
  });

  it('saveBudgetConfig never throws', async () => {
    const exploding = {
      get: () => {
        throw new Error('boom');
      },
      update: async () => {
        throw new Error('boom');
      },
    };
    await saveBudgetConfig(exploding, { day: { hard: 1 } });
    expect(readBudgetConfig(exploding)).toEqual({});
  });
});
