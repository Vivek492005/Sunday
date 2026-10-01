import * as path from 'node:path';
import { loadIndex, type IndexChunk } from './indexer.js';

export interface SearchOptions {
  k?: number;
  maxChars?: number;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

/** Lowercase alphanumeric tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** First line containing any query term, plus two lines of context each side. */
function makeSnippet(chunk: IndexChunk, queryTerms: string[]): string {
  const lines = chunk.text.split('\n');
  let match = 0;
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i]!.toLowerCase();
    if (queryTerms.some((t) => low.includes(t))) {
      match = i;
      break;
    }
  }
  const from = Math.max(0, match - 2);
  const to = Math.min(lines.length, match + 3);
  return lines.slice(from, to).join('\n');
}

/**
 * Rank index chunks against a query with TF-IDF-ish weighting computed over
 * the index (fully deterministic: no randomness anywhere). Returns the top-k
 * hits with snippets; the total snippet text is capped at `maxChars` —
 * snippets that don't fit are truncated and marked with `…`.
 */
export function searchWorkspaceIndex(
  workspaceRoot: string,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const root = path.resolve(workspaceRoot);
  const index = loadIndex(root);
  if (!index) {
    throw new Error(`no index for workspace ${root} — run context/index first`);
  }
  const k = opts.k ?? 5;
  const maxChars = opts.maxChars ?? 8000;
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];

  const infos = index.files.flatMap((f) =>
    f.chunks.map((chunk) => ({ chunk, tf: termFrequencies(tokenize(chunk.text)) })),
  );
  if (infos.length === 0) return [];
  const n = infos.length;
  const df = new Map<string, number>();
  for (const { tf } of infos) {
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // Smoothed idf: rare terms score higher, common terms still count a little.
  const idf = (t: string): number => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;

  const scored: { chunk: IndexChunk; score: number }[] = [];
  for (const { chunk, tf } of infos) {
    let score = 0;
    for (const t of queryTerms) {
      const count = tf.get(t);
      if (count) score += (1 + Math.log(count)) * idf(t);
    }
    if (score > 0) scored.push({ chunk, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.chunk.path !== b.chunk.path) return a.chunk.path < b.chunk.path ? -1 : 1;
    return a.chunk.startLine - b.chunk.startLine;
  });

  const hits: SearchHit[] = [];
  let remaining = maxChars;
  for (const { chunk, score } of scored.slice(0, k)) {
    if (remaining <= 0) break;
    let snippet = makeSnippet(chunk, queryTerms);
    if (snippet.length > remaining) {
      snippet = remaining > 1 ? snippet.slice(0, remaining - 1) + '…' : '…';
    }
    remaining -= snippet.length;
    hits.push({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: round4(score),
      snippet,
    });
  }
  return hits;
}
