/** Orchestration-layer errors. Carries a stable `code` so the daemon can map
 *  these onto JSON-RPC errors without importing transport internals. */

export type OrchestrationErrorCode =
  | 'invalid-params'
  | 'plan-invalid'
  | 'too-many-units'
  | 'plan-overlap'
  | 'dispatch-failed'
  // Parallel-mode codes.
  | 'unknown-run'
  | 'invalid-state'
  | 'resolve-failed';

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;

  constructor(code: OrchestrationErrorCode, message: string) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
  }
}

export type BackgroundAgentErrorCode =
  | 'invalid-params'
  | 'invalid-run-id'
  | 'unknown-run'
  | 'git-failed'
  | 'pr-failed';

/** Background-agent errors. Same stable-`code` convention as OrchestrationError. */
export class BackgroundAgentError extends Error {
  readonly code: BackgroundAgentErrorCode;

  constructor(code: BackgroundAgentErrorCode, message: string) {
    super(message);
    this.name = 'BackgroundAgentError';
    this.code = code;
  }
}
