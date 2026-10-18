/**
 * Typed access to the search bridge (`window.sunday.search`).
 * - text: ripgrep-powered literal search (fast, exact).
 * - hybrid: F5 hybrid retrieval (TF-IDF + symbol graph + embeddings via RRF),
 *   with explainable `why` per hit. Falls back to text when no index exists.
 */
import type { SundayAPI, SearchResult, HybridSearchResult } from '../../electron/preload';

declare global {
  interface Window {
    sunday?: SundayAPI;
  }
}

function bridge(): SundayAPI {
  const api = window.sunday;
  if (!api) {
    throw new Error(
      'Sunday bridge unavailable — the Sunday IDE renderer must run inside the Electron shell (`pnpm dev`).',
    );
  }
  return api;
}

export const searchService = {
  text(query: string, dirPath: string): Promise<SearchResult[]> {
    return bridge().search.text(query, dirPath);
  },
  /** F5: hybrid retrieval. Rejects when no workspace index — caller falls back to text(). */
  hybrid(query: string, dirPath: string): Promise<HybridSearchResult[]> {
    return bridge().search.hybrid(query, dirPath);
  },
};

export type { SearchResult, HybridSearchResult };
