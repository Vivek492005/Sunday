// Tests for context/tokenizer.ts — token estimation is sane.
import { describe, expect, it } from 'vitest';
import { estimateTokens, estimateTokensBatch, formatTokens } from './tokenizer.js';

describe('estimateTokens', () => {
  it('uses char heuristic (~4 chars/token)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('prefers provider-reported usage when present', () => {
    expect(estimateTokens('short', { total_tokens: 1234 })).toBe(1234);
  });

  it('falls back to heuristic when provider usage is absent', () => {
    expect(estimateTokens('a'.repeat(40), {})).toBe(10);
  });
});

describe('estimateTokensBatch', () => {
  it('sums across texts', () => {
    expect(estimateTokensBatch(['abcd', 'efgh'])).toBe(2);
  });
});

describe('formatTokens', () => {
  it('formats compactly', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});
