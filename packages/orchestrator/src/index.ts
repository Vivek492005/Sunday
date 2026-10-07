/** @sunday/orchestrator — Phase 5: hierarchical orchestration (ADR-16/17/18). */
export * from './schemas.js';
export * from './errors.js';
export * from './overlap.js';
export * from './prompts.js';
export * from './toolscope.js';
export * from './host.js';
export * from './planner.js';
export * from './runner.js';
export * from './handlers.js';
export * from './state.js';
export * from './merge.js';
export * from './background.js';
export { decompose, summarizePlan } from './decompose.js';
export type { DecomposeOptions } from './decompose.js';
