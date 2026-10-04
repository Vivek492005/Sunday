// @sunday/eval — shared types for the benchmark harness (§24.2, Phase 7).
//
// A benchmark task is a small, self-contained coding job with a fixture
// workspace and a deterministic checker. A ModelAdapter drives the task —
// either a scripted fake (harness self-tests, no API keys needed) or a live
// run through sundayd over JSON-RPC (real provider models).

import type { ToolResult } from '@sunday/tools';

/** One scripted model step: either a tool call or a final answer. */
export type ScriptStep =
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'answer'; text: string };

export interface EvalTask {
  /** Stable id, e.g. "read-file". */
  id: string;
  title: string;
  /** The prompt a real model would receive. */
  prompt: string;
  /** Populate the temp workspace before the run. */
  setup: (root: string) => void | Promise<void>;
  /** Scripted model behavior for the fake adapter. */
  script: ScriptStep[];
  /**
   * Deterministic checker. Receives the workspace root and the full
   * transcript of tool calls; returns pass/fail with notes.
   */
  check: (root: string, transcript: ExecutedCall[]) => { pass: boolean; notes: string };
}

export interface ExecutedCall {
  tool: string;
  args: Record<string, unknown>;
  /** True when the call passed JSON-Schema validation and executed without error. */
  valid: boolean;
  result: ToolResult;
  durationMs: number;
}

/** Minimal model surface the harness needs. */
export interface ModelAdapter {
  name: string;
  runTask(task: EvalTask, workspaceRoot: string): Promise<ExecutedCall[]>;
}

export interface TaskResult {
  taskId: string;
  title: string;
  pass: boolean;
  notes: string;
  toolCalls: number;
  validCalls: number;
  /** Fraction of tool calls that were schema-valid and error-free. */
  toolReliability: number;
  durationMs: number;
}

export interface BenchmarkReport {
  adapter: string;
  startedAt: string;
  durationMs: number;
  tasks: TaskResult[];
  passed: number;
  total: number;
  /** Mean tool reliability across tasks. */
  meanToolReliability: number;
}

/** Token usage harvested from `usage` chat events during one task. */
export interface BaselineUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Per-task result for a live-model baseline run (extends TaskResult with token usage). */
export interface BaselineTaskResult extends TaskResult {
  inputTokens: number;
  outputTokens: number;
}

/** Release pass targets for a live-model baseline (1.0-beta gate #3). */
export interface BaselineTargets {
  /** Minimum fraction of tasks that must pass, e.g. 0.8. */
  minPassRate: number;
  /** Minimum mean tool reliability across tasks, e.g. 0.95. */
  minMeanToolReliability: number;
  /** Per-task wall-clock budget; a task exceeding it is a failure. */
  maxTaskDurationMs: number;
}

/** Full live-model baseline report (JSON-serializable). */
export interface BaselineReport {
  adapter: string;
  /** Model override used, if any (SUNDAY_EVAL_MODEL). */
  model?: string;
  /** Provider key env vars that were present (names only — never values). */
  providerKeys: string[];
  startedAt: string;
  durationMs: number;
  tasks: BaselineTaskResult[];
  passed: number;
  total: number;
  meanToolReliability: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** p50/p95 task latency in ms (informational — not gating). */
  latencyP50Ms: number;
  latencyP95Ms: number;
  targets: BaselineTargets;
  targetsMet: boolean;
  targetNotes: string[];
}
