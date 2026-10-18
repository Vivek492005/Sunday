// @sunday/eval — F12 × F3 router feed tests.
import { describe, expect, it } from 'vitest';
import {
  buildModelQualityFeed,
  suggestedQualityTier,
  type EvalQualityTier,
} from './routerFeed.js';
import { buildScoreboard, type ScoreboardRun, type ScoreboardTask } from './scoreboard.js';

function task(over: Partial<ScoreboardTask> & { taskId: string }): ScoreboardTask {
  return { pass: true, toolReliability: 1, durationMs: 100, ...over };
}

describe('suggestedQualityTier', () => {
  const cases: Array<[number, EvalQualityTier]> = [
    [1, 'strong'],
    [0.9, 'strong'],
    [0.89, 'balanced'],
    [0.75, 'balanced'],
    [0.74, 'fast'],
    [0.55, 'fast'],
    [0.54, 'tiny'],
    [0, 'tiny'],
  ];
  for (const [rate, tier] of cases) {
    it(`pass rate ${rate} → ${tier}`, () => {
      expect(suggestedQualityTier(rate)).toBe(tier);
    });
  }
});

describe('buildModelQualityFeed', () => {
  it('builds a gateway-consumable feed from scoreboard aggregates', () => {
    const runs: ScoreboardRun[] = [
      {
        model: 'meta-llama/llama-3.3-70b-instruct',
        adapter: 'fake-scripted',
        packVersion: 2,
        startedAt: '2026-10-18T00:00:00Z',
        tasks: [
          task({ taskId: 'a', pass: true, requests: 10, loopTriggers: 1 }),
          task({ taskId: 'b', pass: true, requests: 20 }),
        ],
      },
    ];
    const scores = buildScoreboard(runs);
    const feed = buildModelQualityFeed(scores, '2026-10-18T00:00:00Z');
    expect(feed.packVersion).toBe(2);
    expect(feed.entries).toHaveLength(1);
    const e = feed.entries[0];
    expect(e.model).toBe('meta-llama/llama-3.3-70b-instruct');
    expect(e.passRate).toBe(1);
    expect(e.suggestedTier).toBe('strong');
    expect(e.costPerSuccessfulTaskRequests).toBeCloseTo(15);
    expect(e.loopTriggerRate).toBeCloseTo(0.5);
    // JSON-serializable (gateway reads it from disk)
    expect(() => JSON.parse(JSON.stringify(feed))).not.toThrow();
  });
});
