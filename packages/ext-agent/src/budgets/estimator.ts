// sunday-agent — F1 Cost & Quota Cockpit: pre-run task estimator.
//
// Heuristic v1: before a task is sent, estimate an approx requests range
// ("yeh task ~12–30 requests lega") from message features. Pure function,
// unit-tested. NOT a guarantee — the acceptance gate is p80 within ±40%
// over 20 recorded tasks; tune the weights in one place (WEIGHTS below)
// as real data comes in.

/** Pre-run estimate for a task. */
export interface TaskEstimate {
  /** Lower bound of expected gateway requests. */
  minRequests: number;
  /** Upper bound of expected gateway requests. */
  maxRequests: number;
  /** Midpoint, handy for budget math. */
  pointRequests: number;
  /** How much to trust the range. */
  confidence: 'low' | 'medium' | 'high';
  /** Short human reason, shown in the UI next to the range. */
  rationale: string;
}

export interface EstimateOptions {
  /** Model id (e.g. 'auto', 'llama-3.3-70b'); reserved for model factors. */
  modelId?: string;
  /** Rolling average requests/task from the local ledger (blends in). */
  pastAvgRequests?: number;
}

/** Tunable weights — change data here, not code paths. */
export const ESTIMATOR_WEIGHTS = {
  base: 4,
  perChars: 400,
  perCharsAdd: 1.5,
  codeBlockAdd: 3,
  researchWordAdd: 1.5,
  executionWordAdd: 3,
  buildWordAdd: 4.5,
  minFloor: 2,
  lowFactor: 0.6,
  highFactor: 1.6,
} as const;

const CODE_BLOCK_RE = /```/g;
const RESEARCH_RE = /\b(how|why|explain|what|compare|research|investigate|find out)\b/i;
const EXECUTION_RE = /\b(test|run|build|fix|debug|execute)\b/i;
const BUILD_RE = /\b(refactor|migrate|implement|rewrite|scaffold|feature)\b/i;

function countMatches(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s)) n++;
  re.lastIndex = 0;
  return n;
}

/**
 * Estimate the request range for a task message. Pure — no I/O.
 *
 * Heuristic: base cost + length + code blocks + intent keywords, blended
 * with the ledger's rolling average when available.
 */
export function estimateTask(message: string, opts: EstimateOptions = {}): TaskEstimate {
  const w = ESTIMATOR_WEIGHTS;
  const text = message ?? '';
  const reasons: string[] = [];

  let point: number = w.base;
  reasons.push('base turn cost');

  const lenAdd = Math.floor(text.length / w.perChars) * w.perCharsAdd;
  if (lenAdd > 0) {
    point += lenAdd;
    reasons.push('message length');
  }

  const codeBlocks = Math.floor(countMatches(CODE_BLOCK_RE, text) / 2);
  if (codeBlocks > 0) {
    point += codeBlocks * w.codeBlockAdd;
    reasons.push(`${codeBlocks} code block${codeBlocks > 1 ? 's' : ''}`);
  }
  if (RESEARCH_RE.test(text)) {
    point += w.researchWordAdd;
    reasons.push('research intent');
  }
  if (EXECUTION_RE.test(text)) {
    point += w.executionWordAdd;
    reasons.push('run/test/fix loop');
  }
  if (BUILD_RE.test(text)) {
    point += w.buildWordAdd;
    reasons.push('multi-file build');
  }

  // Blend with observed history when we have it (50/50).
  let confidence: TaskEstimate['confidence'] =
    text.trim().length < 20 ? 'low' : 'medium';
  if (
    typeof opts.pastAvgRequests === 'number' &&
    Number.isFinite(opts.pastAvgRequests) &&
    opts.pastAvgRequests > 0
  ) {
    point = Math.round((point + opts.pastAvgRequests) / 2);
    confidence = 'high';
    reasons.push('blended with your history');
  }

  point = Math.max(w.minFloor, Math.round(point));
  const minRequests = Math.max(w.minFloor, Math.round(point * w.lowFactor));
  const maxRequests = Math.max(minRequests + 1, Math.round(point * w.highFactor));

  return {
    minRequests,
    maxRequests,
    pointRequests: point,
    confidence,
    rationale: reasons.join(' + '),
  };
}

/** One-line display: "~12–30 requests". */
export function formatEstimate(e: TaskEstimate): string {
  return `~${e.minRequests}–${e.maxRequests} requests`;
}
