/**
 * F5 Hybrid Retrieval — pluggable embedding backend.
 *
 * PRIVACY CONTRACT (hard rule, do not weaken):
 * - Embeddings are computed LOCALLY ONLY by default. No network calls.
 * - Vectors are NEVER sent to any remote provider unless the user has
 *   explicitly opted in by selecting a remote embedding provider in settings.
 * - The default backend is {@link NullEmbeddingBackend}: it embeds nothing
 *   and retrieval gracefully falls back to TF-IDF + symbol graph.
 *
 * A real local backend (ONNX small model, or Ollama embeddings served on
 * localhost) can be plugged in via {@link EmbeddingBackend} without touching
 * the fusion code in `search.ts`.
 */

export interface EmbeddingBackend {
  /** Stable identifier, e.g. 'none' | 'onnx-local' | 'ollama'. */
  readonly name: string;
  /** Vector dimensionality. */
  readonly dim: number;
  /** True when vectors leave the machine (requires explicit user opt-in). */
  readonly remote: boolean;
  /** Embed a batch of texts. Must not perform network I/O unless remote. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Default backend: embeds nothing. Retrieval that depends on vectors is
 * skipped and the remaining signals (TF-IDF, symbol graph) carry the query.
 * Local-only, zero network, zero downloads.
 */
export class NullEmbeddingBackend implements EmbeddingBackend {
  readonly name = 'none';
  readonly dim = 0;
  readonly remote = false;
  async embed(_texts: string[]): Promise<Float32Array[]> {
    return [];
  }
}

/**
 * Opt-in remote backend base class. Subclasses implement `embedRemote`;
 * construction throws unless the user explicitly opted in — this makes
 * accidental remote exfiltration a loud failure instead of a silent one.
 */
export abstract class RemoteEmbeddingBackend implements EmbeddingBackend {
  abstract readonly name: string;
  abstract readonly dim: number;
  readonly remote = true;
  protected constructor(optIn: { remoteEmbeddings: true }) {
    if (!optIn || optIn.remoteEmbeddings !== true) {
      throw new Error(
        'remote embedding backends require explicit user opt-in ({ remoteEmbeddings: true })',
      );
    }
  }
  abstract embed(texts: string[]): Promise<Float32Array[]>;
}

/** Cosine similarity in [-1, 1]. Returns 0 for degenerate inputs. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface EmbeddingDoc {
  id: string;
  vector: Float32Array;
}

/**
 * Minimal in-memory vector store with brute-force cosine search.
 * Sufficient for the local-embedding path; swap for an HNSW index if
 * corpora grow beyond ~100k vectors.
 */
export class EmbeddingIndex {
  private docs: EmbeddingDoc[] = [];

  constructor(private readonly backend: EmbeddingBackend) {}

  get backendName(): string {
    return this.backend.name;
  }

  get size(): number {
    return this.docs.length;
  }

  clear(): void {
    this.docs = [];
  }

  async add(id: string, text: string): Promise<void> {
    const [vec] = await this.backend.embed([text]);
    if (!vec || vec.length === 0) return; // NullEmbeddingBackend: no-op
    this.docs.push({ id, vector: vec });
  }

  async search(queryText: string, k: number): Promise<{ id: string; score: number }[]> {
    if (this.docs.length === 0) return [];
    const [qvec] = await this.backend.embed([queryText]);
    if (!qvec || qvec.length === 0) return [];
    const scored = this.docs.map((d) => ({
      id: d.id,
      score: cosineSimilarity(qvec, d.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, k));
  }
}

/** A tiny deterministic test backend (hash-seeded vectors, no network). */
export class TestEmbeddingBackend implements EmbeddingBackend {
  readonly name = 'test';
  readonly remote = false;
  constructor(readonly dim = 16) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      let h = 2166136261;
      for (let i = 0; i < t.length; i++) {
        h ^= t.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      let s = h >>> 0;
      for (let d = 0; d < this.dim; d++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        v[d] = (s % 1000) / 1000 - 0.5;
      }
      return v;
    });
  }
}
