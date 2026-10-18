// @sunday/eval — F12 scoreboard generator tests.
import { describe, expect, it } from 'vitest';
import {
  aggregateModelRuns,
  buildScoreboard,
  estimateTaskCostUsd,
  renderScoreboard,
  type ScoreboardRun,
  type ScoreboardTask,
} from './scoreboard.js';

function task(over: Partial<ScoreboardTask> & { taskId: string }): ScoreboardTask {
  return {
    pass: true,
    toolReliability: 1,
    durationMs: 100,
    ...over,
  };
}

function run(model: string, tasks: ScoreboardTask[], startedAt = '2026-10-18T00:00:00.000Z'): ScoreboardRun {
  return { model, adapter: 'fake-scripted', packVersion: 2, startedAt, tasks };
}

describe('estimateTaskCostUsd', () => {
  it('prefers an explicit costUsd', () => {
    expect(
      estimateTaskCostUsd({ costUsd: 0.0123, inputTokens: 999, outputTokens: 999 }, 'x'),
    ).toBe(0.0123);
  });

  it('estimates from tokens via the pricing table', () => {
    // llama-3.3-70b-instruct: $0.35 / $0.40 per 1M
    const cost = estimateTaskCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'meta-llama/llama-3.3-70b-instruct',
    );
    expect(cost).toBeCloseTo(0.75, 6);
  });

  it('returns undefined when no cost signal exists', () => {
    expect(estimateTaskCostUsd({}, 'x')).toBeUndefined();
  });
});

describe('aggregateModelRuns', () => {
  it('computes pass rate, reliability, median time', () => {
    const s = aggregateModelRuns([
      run('m1', [
        task({ taskId: 'a', pass: true, toolReliability: 1, durationMs: 100 }),
        task({ taskId: 'b', pass: false, toolReliability: 0.5, durationMs: 300 }),
        task({ taskId: 'c', pass: true, toolReliability: 1, durationMs: 200 }),
      ]),
    ]);
    expect(s.passRate).toBeCloseTo(2 / 3);
    expect(s.meanToolReliability).toBeCloseTo(2.5 / 3);
    expect(s.medianDurationMs).toBe(200);
    expect(s.runs).toBe(1);
    expect(s.passRateMin).toBe(s.passRateMax);
  });

  it('cost-per-success counts ONLY verifier-passing tasks (F1)', () => {
    const s = aggregateModelRuns([
      run('m1', [
        task({ taskId: 'a', pass: true, requests: 10 }),
        task({ taskId: 'b', pass: true, requests: 20 }),
        task({ taskId: 'c', pass: false, requests: 1000 }),
      ]),
    ]);
    // The failed 1000-request task must NOT move the average.
    expect(s.costPerSuccessfulTaskRequests).toBeCloseTo(15);
    expect(s.costPerSuccessfulTaskUsd).toBeUndefined();
  });

  it('prefers USD cost when token pricing is known', () => {
    const s = aggregateModelRuns([
      run('meta-llama/llama-3.3-70b-instruct', [
        task({ taskId: 'a', pass: true, inputTokens: 1_000_000, outputTokens: 0 }),
        task({ taskId: 'b', pass: false, inputTokens: 9_000_000, outputTokens: 0 }),
      ]),
    ]);
    expect(s.costPerSuccessfulTaskUsd).toBeCloseTo(0.35, 6);
  });

  it('computes the F2 loop-trigger rate', () => {
    const s = aggregateModelRuns([
      run('m1', [
        task({ taskId: 'a', pass: true, loopTriggers: 0 }),
        task({ taskId: 'b', pass: true, loopTriggers: 2 }),
        task({ taskId: 'c', pass: false, loopTriggers: 0 }),
        task({ taskId: 'd', pass: true }),
      ]),
    ]);
    expect(s.loopTriggerRate).toBeCloseTo(0.25);
    expect(s.totalLoopTriggers).toBe(2);
  });

  it('pools repetitions and reports pass-rate variance', () => {
    const s = aggregateModelRuns([
      run('m1', [task({ taskId: 'a', pass: true }), task({ taskId: 'b', pass: true })], 't1'),
      run('m1', [task({ taskId: 'a', pass: true }), task({ taskId: 'b', pass: false })], 't2'),
    ]);
    expect(s.runs).toBe(2);
    expect(s.total).toBe(4);
    expect(s.passRate).toBeCloseTo(0.75);
    expect(s.passRateMin).toBeCloseTo(0.5);
    expect(s.passRateMax).toBe(1);
  });

  it('builds per-category breakdowns', () => {
    const s = aggregateModelRuns([
      run('m1', [
        task({ taskId: 'a', category: 'bugfix', pass: true }),
        task({ taskId: 'b', category: 'bugfix', pass: false }),
        task({ taskId: 'c', category: 'security', pass: true }),
      ]),
    ]);
    expect(s.byCategory['bugfix'].passRate).toBeCloseTo(0.5);
    expect(s.byCategory['security'].passRate).toBe(1);
  });

  it('throws on empty input', () => {
    expect(() => aggregateModelRuns([])).toThrow(/no runs/);
  });
});

describe('buildScoreboard', () => {
  it('ranks by pass rate, cheaper cost breaks ties', () => {
    const scores = buildScoreboard([
      run('cheap', [task({ taskId: 'a', pass: true, requests: 5 }), task({ taskId: 'b', pass: true, requests: 5 })]),
      run('spendy', [task({ taskId: 'a', pass: true, requests: 50 }), task({ taskId: 'b', pass: true, requests: 50 })]),
      run('bad', [task({ taskId: 'a', pass: false }), task({ taskId: 'b', pass: false })]),
    ]);
    expect(scores.map((s) => s.model)).toEqual(['cheap', 'spendy', 'bad']);
  });
});

describe('renderScoreboard', () => {
  const scores = buildScoreboard([
    run('model-a', [
      task({ taskId: 'a', category: 'bugfix', pass: true, requests: 8, durationMs: 120 }),
      task({ taskId: 'b', category: 'security', pass: false, requests: 40, durationMs: 340 }),
    ]),
    run('model-b', [
      task({ taskId: 'a', category: 'bugfix', pass: true, inputTokens: 1000, outputTokens: 500, durationMs: 200 }),
      task({ taskId: 'b', category: 'security', pass: true, inputTokens: 2000, outputTokens: 500, durationMs: 400 }),
    ]),
  ]);

  it('generates valid markdown with summary + category tables', () => {
    const md = renderScoreboard(scores, { generatedAt: '2026-10-18T00:00:00Z', packVersion: 2 });
    expect(md).toContain('# Sunday Eval Scoreboard');
    expect(md).toContain('task pack v2');
    expect(md).toContain('| Model | Runs | Pass rate |');
    expect(md).toContain('| model-a | 1 | 50.0%');
    expect(md).toContain('| model-b | 1 | 100.0%');
    // F1 cost-per-success: model-a = 8 req (only passing task), model-b = USD estimate
    expect(md).toContain('8.0 req');
    expect(md).toContain('$');
    // F2 loop-trigger column present
    expect(md).toContain('Loop-trigger rate');
    // Per-category breakdown
    expect(md).toContain('## Per-category pass rates');
    expect(md).toContain('bugfix');
    expect(md).toContain('security');
    // Methodology documents the metrics
    expect(md).toContain('## Methodology');
    expect(md).toContain('F1');
    expect(md).toContain('F2');
  });

  it('shows n/a when cost is unknown', () => {
    const s = buildScoreboard([run('m', [task({ taskId: 'a', pass: true })])]);
    const md = renderScoreboard(s);
    expect(md).toContain('n/a');
  });

  it('shows pass-rate range for multi-run models', () => {
    const s = buildScoreboard([
      run('m', [task({ taskId: 'a', pass: true })], 't1'),
      run('m', [task({ taskId: 'a', pass: false })], 't2'),
    ]);
    const md = renderScoreboard(s);
    expect(md).toContain('range 0.0%–100.0%');
  });
});
