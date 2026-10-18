// sunday-agent — F2 Loop Breaker: LoopGuard types.
//
// Pure types only (no vscode, no node imports) so the guard can be shared
// with the sundayd sidecar, which runs the real tool-call loop.

/** What the breaker does when it trips. */
export type LoopGuardAction = 'pause' | 'escalate' | 'abort';

/** Which detector fired. */
export type LoopGuardDetectorKind =
  | 'repeated-tool-args'
  | 'repeated-failure'
  | 'apply-revert-pingpong'
  | 'spend-no-progress';

/** User-facing options offered when the breaker trips (renderer contract). */
export type LoopGuardSuggestedAction =
  | 'change-strategy'
  | 'retry-stronger-model'
  | 'ask-user';

export interface LoopGuardPolicy {
  /** Master switch. */
  enabled: boolean;
  /** Repeats needed to trip (spec: default 3). */
  threshold: number;
  /** What to do on trip. */
  action: LoopGuardAction;
  /** Sliding-window size (tool-call records kept). */
  windowSize: number;
  /** Min cumulative tokens in window before the spend-divergence detector arms. */
  divergenceMinTokens: number;
  /** Min records in window before the spend-divergence detector arms. */
  divergenceMinCalls: number;
}

export const DEFAULT_LOOP_GUARD_POLICY: LoopGuardPolicy = {
  enabled: true,
  threshold: 3,
  action: 'pause',
  windowSize: 12,
  divergenceMinTokens: 15000,
  divergenceMinCalls: 4,
};

/** One tool call observed by the guard. */
export interface ToolCallRecord {
  tool: string;
  /** Normalized hash of tool + args (see hash.ts). */
  argsHash: string;
  /** Normalized error signature when the call failed (see hash.ts). */
  errorSignature?: string;
  isError: boolean;
  inputTokens: number;
  outputTokens: number;
  /** 1 when a mutating tool succeeded (file actually changed). */
  filesChanged: number;
  /** true when a test run succeeded. */
  testsPassed: boolean;
  /** For ping-pong detection: file path for edit/write tools. */
  filePath?: string;
  /** For ping-pong detection: hash of the written content. */
  contentHash?: string;
  timestamp: number;
}

/** Structured trip report — the renderer contract for the pause UI. */
export interface LoopGuardTrigger {
  kind: LoopGuardDetectorKind;
  /** How many repeats were observed. */
  count: number;
  threshold: number;
  /** Human-readable explanation. */
  message: string;
  /** Evidence for debugging / UI detail view. */
  evidence: {
    tool?: string;
    argsHash?: string;
    errorSignature?: string;
    filePath?: string;
    windowTokens?: number;
  };
  suggestedActions: LoopGuardSuggestedAction[];
}

/** Input for the post-execution hook. */
export interface ToolResultInput {
  tool: string;
  isError: boolean;
  /** Raw result text (used for error signatures; redacted before hashing). */
  resultText?: string;
  inputTokens?: number;
  outputTokens?: number;
}
