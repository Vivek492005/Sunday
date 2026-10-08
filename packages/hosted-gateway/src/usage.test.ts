import { describe, expect, it } from 'vitest';
import { UsageMeter } from './usage.js';

const DAY = 86_400_000;

describe('UsageMeter', () => {
  it('returns a zeroed snapshot for unknown users (empty data)', () => {
    const m = new UsageMeter();
    const s = m.snapshot('nobody');
    expect(s.today).toEqual({ requests: 0, tokens_in: 0, tokens_out: 0 });
    expect(s.by_model).toEqual([]);
    expect(s.history_7d).toHaveLength(7);
    expect(s.history_7d.every((p) => p.requests === 0)).toBe(true);
  });

  it('aggregates requests and tokens for today', () => {
    const m = new UsageMeter();
    m.record('u1', 'openrouter:llama', 100, 50);
    m.record('u1', 'openrouter:llama', 200, 100);
    const s = m.snapshot('u1');
    expect(s.today).toEqual({ requests: 2, tokens_in: 300, tokens_out: 150 });
    expect(s.by_model).toEqual([{ model: 'openrouter:llama', requests: 2, tokens: 450 }]);
  });

  it('breaks down by model across models, sorted by requests desc', () => {
    const m = new UsageMeter();
    m.record('u1', 'b', 10, 10);
    m.record('u1', 'a', 10, 10);
    m.record('u1', 'a', 10, 10);
    const s = m.snapshot('u1');
    expect(s.by_model.map((x) => x.model)).toEqual(['a', 'b']);
    expect(s.by_model[0]).toEqual({ model: 'a', requests: 2, tokens: 40 });
  });

  it('builds a 7-day history with correct day buckets', () => {
    const m = new UsageMeter();
    const now = Date.now();
    m.record('u1', 'm', 1, 1, now - 2 * DAY);
    m.record('u1', 'm', 1, 1, now - 2 * DAY);
    m.record('u1', 'm', 1, 1, now);
    const s = m.snapshot('u1');
    expect(s.history_7d).toHaveLength(7);
    expect(s.history_7d[4].requests).toBe(2); // 2 days ago
    expect(s.history_7d[6].requests).toBe(1); // today
    expect(s.history_7d[0].requests).toBe(0); // 6 days ago
    // days are consecutive YYYY-MM-DD
    const days = s.history_7d.map((p) => p.day);
    expect(new Set(days).size).toBe(7);
    expect(days[6]).toBe(new Date().toISOString().slice(0, 10));
  });

  it('isolates users from each other', () => {
    const m = new UsageMeter();
    m.record('alice', 'm', 5, 5);
    expect(m.snapshot('bob').today.requests).toBe(0);
    expect(m.snapshot('alice').today.requests).toBe(1);
  });

  it('ignores empty user keys and model names', () => {
    const m = new UsageMeter();
    m.record('', 'm', 1, 1);
    m.record('u', '', 1, 1);
    expect(m.snapshot('u').today.requests).toBe(0);
    expect(m.snapshot('').today.requests).toBe(0);
  });

  it('clamps negative/NaN token counts', () => {
    const m = new UsageMeter();
    m.record('u', 'm', -5, NaN);
    expect(m.snapshot('u').today).toEqual({ requests: 1, tokens_in: 0, tokens_out: 0 });
  });

  it('prunes buckets older than the retention window', () => {
    const m = new UsageMeter();
    m.record('u', 'm', 1, 1, Date.now() - 10 * DAY);
    m.record('u', 'm', 1, 1, Date.now() - 20 * DAY);
    m.record('u', 'm', 1, 1); // today — triggers prune
    const s = m.snapshot('u');
    expect(s.history_7d.every((p) => p.day >= new Date(Date.now() - 6 * DAY).toISOString().slice(0, 10))).toBe(true);
    // the ancient records no longer inflate any visible aggregate
    expect(s.today.requests).toBe(1);
    expect(s.by_model[0].requests).toBe(1);
  });
});
