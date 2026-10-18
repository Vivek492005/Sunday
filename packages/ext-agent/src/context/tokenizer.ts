// sunday-agent — F4 Context Cockpit: token estimation.
//
// Provider-reported usage wins when available; otherwise a char-count
// heuristic (≈4 chars/token for code+prose mix). Pure function, unit-tested.
// NOT a guarantee — it is a meter, not a billing counter.

/** Heuristic: average chars per token for mixed code/prose. */
export const CHARS_PER_TOKEN = 4;

/** Provider-reported usage (e.g. OpenAI-style usage block). */
export interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Estimate tokens for a text. When provider usage is available and covers
 * the text (total_tokens), it is used verbatim; otherwise chars/4.
 */
export function estimateTokens(text: string, providerUsage?: ProviderUsage): number {
  if (
    providerUsage &&
    typeof providerUsage.total_tokens === 'number' &&
    providerUsage.total_tokens >= 0
  ) {
    return Math.round(providerUsage.total_tokens);
  }
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Estimate tokens for a list of texts. */
export function estimateTokensBatch(texts: string[]): number {
  let total = 0;
  for (const t of texts) total += estimateTokens(t);
  return total;
}

/**
 * Format a token count for display: 1.2k, 45k, 1.3M.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
