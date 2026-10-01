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
