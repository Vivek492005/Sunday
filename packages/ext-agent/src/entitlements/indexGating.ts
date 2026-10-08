// sunday-agent — codebase-index entitlement cap (Task 7).
//
// Byte cap for the workspace indexer derived from the
// `codebase_index.max_repo_mb` entitlement. When entitlements are unknown,
// the fallback is 100 MB — the same default @sunday/context's indexer
// enforces on its own, so the two sides agree.

import { maxRepoMb, type EntitlementsView } from './types.js';

/** Fallback when entitlements are unavailable (matches the indexer's own default). */
export const FALLBACK_INDEX_MAX_BYTES = 100 * 1024 * 1024;

const BYTES_PER_MB = 1024 * 1024;

/** Max repo bytes the plan allows to index (fail-open fallback: 100 MB). */
export function maxIndexBytes(view: EntitlementsView | undefined): number {
  if (!view) return FALLBACK_INDEX_MAX_BYTES;
  return Math.max(1, Math.floor(maxRepoMb(view))) * BYTES_PER_MB;
}

/**
 * Clear, non-silent message surfaced when indexing stops at the plan's
 * cap — e.g. "Indexing stopped at 500 MB — your plan's limit".
 */
export function indexCapMessage(maxBytes: number): string {
  const mb = Math.max(1, Math.round(maxBytes / BYTES_PER_MB));
  return `Indexing stopped at ${mb} MB — your plan's limit`;
}
