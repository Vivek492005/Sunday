// sunday-agent — F2 Loop Breaker: public surface.
//
// Pure (no vscode import) — safe to import from the sundayd sidecar.
export {
  LoopGuard,
  MUTATING_TOOLS,
  inferProgressSignals,
  type CallToken,
} from './loopGuard.js';
export {
  DEFAULT_LOOP_GUARD_POLICY,
  type LoopGuardAction,
  type LoopGuardDetectorKind,
  type LoopGuardPolicy,
  type LoopGuardSuggestedAction,
  type LoopGuardTrigger,
  type ToolCallRecord,
  type ToolResultInput,
} from './types.js';
export { errorSignature, hashString, hashToolCall, normalizeArgs } from './hash.js';
