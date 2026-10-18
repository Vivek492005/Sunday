import * as path from 'node:path';
import { loadIndex, type IndexChunk, type WorkspaceIndex } from './indexer.js';
import {
  loadSymbolGraph,
  findReferences,
  type SymbolGraph,
} from './symbols.js';
import { NullEmbeddingBackend, EmbeddingIndex } from './embeddings.js';

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
  /**
   * F5: human-readable explanation of WHY this file matched, e.g.
   * "TF-IDF match on 'retry, backoff'; defines symbol `withRetry` (function)".
   * Every retrieval path must populate this — retrieval is explainable.
   */
  why: string;
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

interface ScoredChunk {
  chunk: IndexChunk;
  score: number;
}

/** TF-IDF-ish scoring over the index (deterministic, no randomness). */
function scoreChunksTfIdf(index: WorkspaceIndex, queryTerms: string[]): ScoredChunk[] {
  const infos = index.files.flatMap((f) =>
    f.chunks.map((chunk) => ({ chunk, tf: termFrequencies(tokenize(chunk.text)) })),
  );
  if (infos.length === 0) return [];
  const n = infos.length;
  const df = new Map<string, number>();
  for (const { tf } of infos) {
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = (t: string): number => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;

  const scored: ScoredChunk[] = [];
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
  return scored;
}

/** Rank chunks against a query with TF-IDF-ish weighting computed over
 *  the index (fully deterministic: no randomness anywhere). Returns the top-k
 *  hits with snippets; the total snippet text is capped at `maxChars` —
 *  snippets that don't fit are truncated and marked with `…`.
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

  const scored = scoreChunksTfIdf(index, queryTerms);
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
      why: `TF-IDF match on '${queryTerms.join(', ')}'`,
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// F5: Reciprocal Rank Fusion + hybrid search
// ---------------------------------------------------------------------------

/** RRF constant — standard value from the RRF paper (Cormack et al. 2009). */
export const RRF_K = 60;

export interface RankedDoc {
  /** Stable identity across signals, e.g. `path:startLine`. */
  key: string;
  /** Explanation contributed by this signal. */
  why: string;
}

/**
 * Reciprocal Rank Fusion: merge several ranked lists into one.
 * fusedScore(doc) = Σ over lists of 1 / (RRF_K + rank_in_list).
 * Deterministic; ties broken by key for stability.
 */
export function fuse(lists: RankedDoc[][], k: number): { key: string; score: number; whys: string[] }[] {
  const scores = new Map<string, number>();
  const whys = new Map<string, string[]>();
  for (const list of lists) {
    list.forEach((doc, rank) => {
      scores.set(doc.key, (scores.get(doc.key) ?? 0) + 1 / (RRF_K + rank + 1));
      const w = whys.get(doc.key) ?? [];
      if (!w.includes(doc.why)) w.push(doc.why);
      whys.set(doc.key, w);
    });
  }
  return [...scores.entries()]
    .map(([key, score]) => ({ key, score: round4(score), whys: whys.get(key) ?? [] }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.key < b.key ? -1 : 1))
    .slice(0, Math.max(0, k));
}

export interface HybridSearchOptions extends SearchOptions {
  /**
   * Optional pre-loaded symbol graph (avoids disk I/O in hot paths).
   * When omitted, the persisted graph is loaded if present.
   */
  symbolGraph?: SymbolGraph | null;
  /**
   * Optional embedding index. Defaults to a NullEmbeddingBackend index
   * (local-only, no-op) — embeddings never go remote unless the caller
   * explicitly wires an opted-in backend.
   */
  embeddingIndex?: EmbeddingIndex;
  /** Skip the symbol signal even when a graph is available. */
  noSymbols?: boolean;
}

const SYMBOL_KIND_RANK: Record<string, number> = {
  function: 0,
  method: 0,
  class: 1,
  interface: 2,
  type: 2,
  variable: 3,
  constant: 3,
  import: 4,
  file: 5,
};

/** Ranked symbol matches for the query terms (name-based, deterministic). */
function rankSymbols(graph: SymbolGraph, queryTerms: string[]): RankedDoc[] {
  interface Cand {
    key: string;
    name: string;
    kind: string;
    path: string;
    line: number;
  }
  const cands: Cand[] = [];
  for (const [relPath, entry] of Object.entries(graph.files)) {
    for (const s of entry.symbols) {
      if (s.kind === 'import' || s.kind === 'file') continue;
      const lname = s.name.toLowerCase();
      let rank = -1;
      for (const t of queryTerms) {
        if (lname === t) rank = 0;
        else if (lname.startsWith(t) || t.startsWith(lname)) rank = Math.max(rank, 1);
        else if (lname.includes(t) || t.includes(lname)) rank = Math.max(rank, 2);
      }
      if (rank >= 0) {
        cands.push({
          key: `${relPath}:${s.startLine}`,
          name: s.name,
          kind: s.kind,
          path: relPath,
          line: s.startLine,
        });
      }
    }
  }
  cands.sort((a, b) => {
    const ra = SYMBOL_KIND_RANK[a.kind] ?? 9;
    const rb = SYMBOL_KIND_RANK[b.kind] ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.line - b.line;
  });
  // Also surface files that REFERENCE the matched symbol names.
  const refKeys = new Set<string>();
  const refDocs: RankedDoc[] = [];
  for (const c of cands.slice(0, 10)) {
    for (const hit of findReferences(graph, c.name)) {
      const key = `${hit.path}:${hit.line}`;
      if (key === c.key || refKeys.has(key)) continue;
      refKeys.add(key);
      refDocs.push({ key, why: `references symbol \`${c.name}\`` });
    }
  }
  const defDocs: RankedDoc[] = cands.map((c) => ({
    key: c.key,
    why: `defines symbol \`${c.name}\` (${c.kind})`,
  }));
  return [...defDocs, ...refDocs];
}

export interface HybridSearchDeps {
  index: WorkspaceIndex;
  graph: SymbolGraph | null;
  embeddings: EmbeddingIndex;
}

/**
 * Populate an embedding index from workspace chunks (call once after
 * `context/index`; chunk ids are the stable doc ids). With the default
 * NullEmbeddingBackend this is a no-op.
 */
export async function indexChunksForEmbeddings(
  embeddings: EmbeddingIndex,
  index: WorkspaceIndex,
): Promise<number> {
  let n = 0;
  for (const f of index.files) {
    for (const c of f.chunks) {
      await embeddings.add(c.id, c.text);
      n++;
    }
  }
  return n;
}

/**
 * F5 hybrid retrieval: fuse (1) TF-IDF, (2) symbol graph, (3) embeddings
 * (default local-only no-op) with Reciprocal Rank Fusion. Every hit carries
 * an explainable `why`.
 */
export async function hybridSearch(
  workspaceRoot: string,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<SearchHit[]> {
  const root = path.resolve(workspaceRoot);
  const index = loadIndex(root);
  if (!index) {
    throw new Error(`no index for workspace ${root} — run context/index first`);
  }
  const k = opts.k ?? 5;
  const maxChars = opts.maxChars ?? 8000;
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];

  const chunkByKey = new Map<string, IndexChunk>();
  const chunkById = new Map<string, IndexChunk>();
  for (const f of index.files) {
    for (const c of f.chunks) {
      chunkByKey.set(`${c.path}:${c.startLine}`, c);
      chunkById.set(c.id, c);
    }
  }

  // Signal 1: TF-IDF over chunks.
  const tfidfDocs: RankedDoc[] = scoreChunksTfIdf(index, queryTerms).map(({ chunk }) => ({
    key: `${chunk.path}:${chunk.startLine}`,
    why: `TF-IDF match on '${queryTerms.join(', ')}'`,
  }));

  // Signal 2: symbol graph (name matches + referencing files).
  let symbolDocs: RankedDoc[] = [];
  if (!opts.noSymbols) {
    const graph = opts.symbolGraph !== undefined ? opts.symbolGraph : loadSymbolGraph(root);
    if (graph) symbolDocs = rankSymbols(graph, queryTerms);
  }

  // Signal 3: embeddings (pluggable; default is local-only no-op).
  const embeddings = opts.embeddingIndex ?? new EmbeddingIndex(new NullEmbeddingBackend());
  let embeddingDocs: RankedDoc[] = [];
  if (embeddings.size > 0) {
    const embHits = await embeddings.search(query, k * 2);
    embeddingDocs = embHits.flatMap((h) => {
      const chunk = chunkById.get(h.id);
      return chunk
        ? [{ key: `${chunk.path}:${chunk.startLine}`, why: 'semantic embedding match' }]
        : [];
    });
  }

  const fused = fuse([tfidfDocs, symbolDocs, embeddingDocs], Math.max(k * 3, 10));

  const hits: SearchHit[] = [];
  let remaining = maxChars;
  for (const f of fused.slice(0, k)) {
    if (remaining <= 0) break;
    const chunk = chunkByKey.get(f.key);
    let snippet: string;
    let startLine: number;
    let endLine: number;
    let relPath: string;
    if (chunk) {
      snippet = makeSnippet(chunk, queryTerms);
      startLine = chunk.startLine;
      endLine = chunk.endLine;
      relPath = chunk.path;
    } else {
      // Symbol-only hit (no indexed chunk covers that exact line): synthesize
      // a minimal hit from the graph location.
      const [p, lineStr] = f.key.split(':');
      relPath = p!;
      startLine = Number(lineStr) || 1;
      endLine = startLine;
      snippet = '';
    }
    if (snippet.length > remaining) {
      snippet = remaining > 1 ? snippet.slice(0, remaining - 1) + '…' : '…';
    }
    remaining -= snippet.length;
    hits.push({
      path: relPath,
      startLine,
      endLine,
      score: f.score,
      snippet,
      why: f.whys.join('; '),
    });
  }
  return hits;
}
