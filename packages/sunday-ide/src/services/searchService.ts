/**
 * Typed access to the text-search bridge (`window.sunday.search`).
 * The main process runs ripgrep (with a pure-Node fallback) and returns
 * file/line/column matches.
 */
import type { SundayAPI, SearchResult } from '../../electron/preload';

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
};

export type { SearchResult };
