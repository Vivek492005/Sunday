// F12 × F3 — eval-driven quality-tier overrides.
import { describe, expect, it } from 'vitest';
import {
  MODEL_CAPABILITIES,
  applyEvalTiers,
  parseEvalTierFeed,
} from './models.js';

describe('applyEvalTiers', () => {
  it('overrides the static tier for known models only', () => {
    const merged = applyEvalTiers(MODEL_CAPABILITIES, {
      'meta-llama/llama-3.3-70b-instruct': 'tiny',
    });
    expect(merged['meta-llama/llama-3.3-70b-instruct'].qualityTier).toBe('tiny');
    // Untouched models keep their static tier.
    expect(merged['qwen/qwen-2.5-coder-32b-instruct'].qualityTier).toBe(
      MODEL_CAPABILITIES['qwen/qwen-2.5-coder-32b-instruct'].qualityTier,
    );
  });

  it('ignores eval entries for unknown models', () => {
    const merged = applyEvalTiers(MODEL_CAPABILITIES, {
      'nope/not-a-model': 'strong',
    });
    expect(merged['nope/not-a-model']).toBeUndefined();
    expect(Object.keys(merged)).toEqual(Object.keys(MODEL_CAPABILITIES));
  });

  it('does not mutate the base table', () => {
    const before = MODEL_CAPABILITIES['meta-llama/llama-3.3-70b-instruct'].qualityTier;
    applyEvalTiers(MODEL_CAPABILITIES, { 'meta-llama/llama-3.3-70b-instruct': 'tiny' });
    expect(MODEL_CAPABILITIES['meta-llama/llama-3.3-70b-instruct'].qualityTier).toBe(before);
  });

  it('empty feed is a no-op', () => {
    expect(applyEvalTiers(MODEL_CAPABILITIES, {})).toEqual(MODEL_CAPABILITIES);
  });
});

describe('parseEvalTierFeed', () => {
  it('parses the routerFeed JSON shape', () => {
    const feed = {
      generatedAt: '2026-10-18T00:00:00Z',
      packVersion: 2,
      entries: [
        { model: 'meta-llama/llama-3.3-70b-instruct', passRate: 0.97, suggestedTier: 'strong' },
        { model: 'qwen/qwen-2.5-coder-32b-instruct', passRate: 0.6, suggestedTier: 'fast' },
      ],
    };
    expect(parseEvalTierFeed(feed)).toEqual({
      'meta-llama/llama-3.3-70b-instruct': 'strong',
      'qwen/qwen-2.5-coder-32b-instruct': 'fast',
    });
  });

  it('drops malformed entries, returns {} on malformed payloads', () => {
    expect(
      parseEvalTierFeed({ entries: [{ model: 'a', suggestedTier: 'ultra' }, null, { model: 42 }] }),
    ).toEqual({});
    expect(parseEvalTierFeed(null)).toEqual({});
    expect(parseEvalTierFeed({})).toEqual({});
    expect(parseEvalTierFeed('nope')).toEqual({});
  });
});
