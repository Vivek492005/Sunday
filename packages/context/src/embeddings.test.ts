import { describe, expect, it } from 'vitest';
import { cosineSimilarity, EmbeddingIndex, NullEmbeddingBackend, TestEmbeddingBackend } from './embeddings.js';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('is 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe('NullEmbeddingBackend', () => {
  it('embeds nothing, stays local', async () => {
    const b = new NullEmbeddingBackend();
    expect(b.remote).toBe(false);
    expect(await b.embed(['hello'])).toEqual([]);
  });
});

describe('EmbeddingIndex', () => {
  it('is a no-op with the null backend', async () => {
    const idx = new EmbeddingIndex(new NullEmbeddingBackend());
    await idx.add('a', 'hello world');
    expect(idx.size).toBe(0);
    expect(await idx.search('hello', 5)).toEqual([]);
  });

  it('ranks by cosine similarity with a real backend', async () => {
    const idx = new EmbeddingIndex(new TestEmbeddingBackend(16));
    await idx.add('a', 'the quick brown fox');
    await idx.add('b', 'quantum entanglement physics');
    const hits = await idx.search('the quick brown fox', 2);
    expect(hits[0]!.id).toBe('a');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('clear empties the index', async () => {
    const idx = new EmbeddingIndex(new TestEmbeddingBackend(8));
    await idx.add('a', 'x');
    idx.clear();
    expect(idx.size).toBe(0);
  });
});
