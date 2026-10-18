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

/**
 * F12 — versioned task-pack format. Bump when task semantics change so
 * scoreboard runs from different pack versions are never mixed silently.
 */
export const TASK_PACK_VERSION = 2;

/**
 * F12 — task categories. The scoreboard reports per-category pass rates;
 * the pack must cover every REQUIRED_TASK_CATEGORIES entry.
 */
export type TaskCategory =
  | 'io'
  | 'search'
  | 'edit'
  | 'terminal'
  | 'git'
  | 'plan'
  | 'browser'
  | 'infra'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'tests'
  | 'multi-file'
  | 'security';

/** Categories every task pack must include at least one task of (F12). */
export const REQUIRED_TASK_CATEGORIES: readonly TaskCategory[] = [
  'bugfix',
  'feature',
  'refactor',
  'tests',
  'multi-file',
  'security',
] as const;

export interface EvalTask {
  /** Stable id, e.g. "read-file". */
  id: string;
  title: string;
  /** The prompt a real model would receive. */
  prompt: string;
  /** F12: category for the scoreboard breakdown. */
  category: TaskCategory;
  /**
   * F12: fixed seed — fixture setup must be deterministic for this seed,
   * so reruns are reproducible (acceptance: ±5% pass-rate across reruns).
   */
  seed: number;
  /** Populate the temp workspace before the run. */
  setup: (root: string) => void | Promise<void>;
  /** Scripted model behavior for the fake adapter. */
  script: ScriptStep[];
  /**
   * Deterministic checker. Receives the workspace root and the full
   * transcript of tool calls; returns pass/fail with notes.
   *
   * Checkers are hidden from the agent under test: they run in-process in
   * the harness, and tasks never grant the agent write access to the
   * checker's expectations (fixtures only, assertions stay here).
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
  /**
   * F12: optional per-task scoring metadata (cost, tokens, requests).
   * Adapters that can't observe it omit the method; the runner treats
   * missing metadata as unknown rather than zero.
   */
  scoreMetadata?(
    task: EvalTask,
    transcript: ExecutedCall[],
  ): ScoreMetadata | Promise<ScoreMetadata>;
}

/**
 * F12: per-task scoring metadata harvested by the runner.
 * Feeds the public scoreboard (cost-per-success, loop-trigger rate).
 */
export interface ScoreMetadata {
  /** Gateway requests consumed (F1 cost unit). */
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** USD cost when known (live runs priced via the F1 pricing table). */
  costUsd?: number;
  /** F2 LoopGuard trips observed while replaying this task's transcript. */
  loopTriggers?: number;
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
  /** F12: scoring metadata (cost / loop data); absent when unobservable. */
  score?: ScoreMetadata;
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
