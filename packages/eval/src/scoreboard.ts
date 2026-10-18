// @sunday/eval — F12 Public Eval Scoreboard.
//
// Turns per-model benchmark runs into a static, publishable Markdown
// scoreboard: pass rate, tool-call reliability, median time, cost per
// successful task (F1 tie-in), and loop-trigger rate (F2 tie-in).
//
// The scoreboard is DATA, not marketing: the same aggregates feed the F3
// router's model quality tiers (see routerFeed.ts), so eval is product
// input as well as a public artifact.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskCategory } from './types.js';

/** One task's scored outcome, as read from a stored report.json. */
export interface ScoreboardTask {
  taskId: string;
  category?: string;
  pass: boolean;
  toolReliability: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** USD cost when known (live runs). */
  costUsd?: number;
  /** Gateway requests (F1 cost unit; the fake adapter reports these). */
  requests?: number;
  /** F2 LoopGuard trips during this task. */
  loopTriggers?: number;
}

/** One benchmark run for one model (possibly one of several repetitions). */
export interface ScoreboardRun {
  model: string;
  adapter: string;
  packVersion: number;
  startedAt: string;
  tasks: ScoreboardTask[];
}

/** Aggregated per-model score (pooled across repetitions). */
export interface ModelScore {
  model: string;
  /** How many runs were pooled. */
  runs: number;
  packVersion: number;
  total: number;
  passed: number;
  /** Pooled pass rate. */
  passRate: number;
  /** Min/max pass rate across runs (variance signal; single run → equal). */
  passRateMin: number;
  passRateMax: number;
  meanToolReliability: number;
  medianDurationMs: number;
  /**
   * F1 cost-per-successful-task: mean cost over tasks the verifier passed.
   * USD when token pricing is known, otherwise gateway requests.
   */
  costPerSuccessfulTaskUsd?: number;
  costPerSuccessfulTaskRequests?: number;
  /** F2: fraction of tasks with ≥1 LoopGuard trip. */
  loopTriggerRate: number;
  totalLoopTriggers: number;
  byCategory: Record<string, { passed: number; total: number; passRate: number }>;
}

/**
 * Approximate USD price per 1M tokens (input, output) — DATA, update when
 * vendors change pricing. Used only when a run reports tokens but no
 * explicit costUsd; explicit costs always win.
 */
export const TOKEN_PRICES_USD_PER_1M: Record<string, { in: number; out: number }> = {
  'meta-llama/llama-3.3-70b-instruct': { in: 0.35, out: 0.4 },
  'llama-3.3-70b-versatile': { in: 0, out: 0 },
  'qwen/qwen-2.5-coder-32b-instruct': { in: 0.3, out: 0.3 },
  'llama-3.1-8b-instant': { in: 0, out: 0 },
  default: { in: 0.5, out: 0.6 },
};

function priceFor(model: string): { in: number; out: number } {
  return TOKEN_PRICES_USD_PER_1M[model] ?? TOKEN_PRICES_USD_PER_1M.default;
}

/** Estimate USD cost from token counts (explicit costUsd always wins). */
export function estimateTaskCostUsd(
  task: Pick<ScoreboardTask, 'costUsd' | 'inputTokens' | 'outputTokens'>,
  model: string,
): number | undefined {
  if (typeof task.costUsd === 'number' && Number.isFinite(task.costUsd)) return task.costUsd;
  const input = task.inputTokens ?? 0;
  const output = task.outputTokens ?? 0;
  if (input === 0 && output === 0) return undefined;
  const p = priceFor(model);
  return (input / 1e6) * p.in + (output / 1e6) * p.out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate one model's runs (1..n repetitions) into a single score.
 * Tasks are pooled across runs; pass-rate min/max exposes run variance.
 */
export function aggregateModelRuns(runs: ScoreboardRun[]): ModelScore {
  if (runs.length === 0) throw new Error('aggregateModelRuns: no runs');
  const model = runs[0].model;
  const packVersion = runs[0].packVersion;
  const pooled: ScoreboardTask[] = runs.flatMap((r) => r.tasks);
  const total = pooled.length;
  const passed = pooled.filter((t) => t.pass).length;

  const perRunRates = runs.map((r) =>
    r.tasks.length === 0 ? 0 : r.tasks.filter((t) => t.pass).length / r.tasks.length,
  );

  // F1 cost-per-successful-task: ONLY verifier-passing tasks count.
  const successful = pooled.filter((t) => t.pass);
  const usdCosts = successful
    .map((t) => estimateTaskCostUsd(t, model))
    .filter((c): c is number => c !== undefined);
  const reqCosts = successful
    .map((t) => t.requests)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));

  const looped = pooled.filter((t) => (t.loopTriggers ?? 0) > 0).length;
  const totalLoopTriggers = pooled.reduce((s, t) => s + (t.loopTriggers ?? 0), 0);

  const byCategory: ModelScore['byCategory'] = {};
  for (const t of pooled) {
    const cat: string = t.category ?? 'uncategorized';
    const entry = (byCategory[cat] ??= { passed: 0, total: 0, passRate: 0 });
    entry.total += 1;
    if (t.pass) entry.passed += 1;
  }
  for (const entry of Object.values(byCategory)) {
    entry.passRate = entry.total === 0 ? 0 : entry.passed / entry.total;
  }

  return {
    model,
    runs: runs.length,
    packVersion,
    total,
    passed,
    passRate: total === 0 ? 0 : passed / total,
    passRateMin: perRunRates.length === 0 ? 0 : Math.min(...perRunRates),
    passRateMax: perRunRates.length === 0 ? 0 : Math.max(...perRunRates),
    meanToolReliability: mean(pooled.map((t) => t.toolReliability)),
    medianDurationMs: median(pooled.map((t) => t.durationMs)),
    costPerSuccessfulTaskUsd: usdCosts.length === 0 ? undefined : mean(usdCosts),
    costPerSuccessfulTaskRequests: reqCosts.length === 0 ? undefined : mean(reqCosts),
    loopTriggerRate: total === 0 ? 0 : looped / total,
    totalLoopTriggers,
    byCategory,
  };
}

/** Group runs by model, then aggregate each group. */
export function buildScoreboard(runs: ScoreboardRun[]): ModelScore[] {
  const byModel = new Map<string, ScoreboardRun[]>();
  for (const r of runs) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  const scores = [...byModel.values()].map(aggregateModelRuns);
  // Rank: pass rate desc, then cost-per-success asc (cheaper wins ties).
  scores.sort((a, b) => {
    if (b.passRate !== a.passRate) return b.passRate - a.passRate;
    const ca = a.costPerSuccessfulTaskUsd ?? a.costPerSuccessfulTaskRequests ?? Infinity;
    const cb = b.costPerSuccessfulTaskUsd ?? b.costPerSuccessfulTaskRequests ?? Infinity;
    return ca - cb;
  });
  return scores;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function costCell(s: ModelScore): string {
  if (s.costPerSuccessfulTaskUsd !== undefined) {
    return `$${s.costPerSuccessfulTaskUsd.toFixed(4)}`;
  }
  if (s.costPerSuccessfulTaskRequests !== undefined) {
    return `${s.costPerSuccessfulTaskRequests.toFixed(1)} req`;
  }
  return 'n/a';
}

/**
 * Render the static public scoreboard Markdown (written to docs/SCOREBOARD.md).
 * Pure function — easy to test, no I/O.
 */
export function renderScoreboard(
  scores: ModelScore[],
  opts: { generatedAt?: string; packVersion?: number } = {},
): string {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const packVersion = opts.packVersion ?? scores[0]?.packVersion ?? 0;
  const lines: string[] = [
    '# Sunday Eval Scoreboard',
    '',
    `> Generated ${generatedAt} · task pack v${packVersion} · ` +
      `${scores.reduce((s, m) => s + m.total, 0)} task-runs pooled`,
    '',
    'Public, reproducible model benchmark for Sunday agents: every model runs',
    'the same versioned task pack with fixed seeds and hidden checkers.',
    'Cost-per-successful-task counts **only verifier-passing tasks** (F1);',
    'loop-trigger rate replays each transcript through the F2 LoopGuard.',
    '',
    '## Summary',
    '',
    '| Model | Runs | Pass rate | Tool reliability | Median time | Cost / success | Loop-trigger rate |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const s of scores) {
    const variance =
      s.runs > 1 ? ` (range ${pct(s.passRateMin)}–${pct(s.passRateMax)})` : '';
    lines.push(
      `| ${s.model} | ${s.runs} | ${pct(s.passRate)}${variance} | ${pct(s.meanToolReliability)} | ` +
        `${s.medianDurationMs.toFixed(0)}ms | ${costCell(s)} | ${pct(s.loopTriggerRate)} |`,
    );
  }
  lines.push('', '## Per-category pass rates', '');
  const allCats = [...new Set(scores.flatMap((s) => Object.keys(s.byCategory)))].sort();
  lines.push(`| Model | ${allCats.join(' | ')} |`);
  lines.push(`|---|${allCats.map(() => '---').join('|')}|`);
  for (const s of scores) {
    const cells = allCats.map((c) => {
      const e = s.byCategory[c];
      return e ? `${pct(e.passRate)} (${e.passed}/${e.total})` : '—';
    });
    lines.push(`| ${s.model} | ${cells.join(' | ')} |`);
  }
  lines.push(
    '',
    '## Methodology',
    '',
    '- **Task pack**: versioned (`TASK_PACK_VERSION`), fixed seeds, deterministic fixtures;',
    '  checkers run in-process and are never visible to the model under test.',
    '- **Pass** = the hidden checker accepted the resulting workspace state.',
    '- **Tool reliability** = fraction of tool calls that were schema-valid and error-free.',
    '- **Cost / success** = mean cost over verifier-passing tasks only (F1 metric).',
    '  USD via per-model token pricing when tokens are reported; otherwise gateway requests.',
    '- **Loop-trigger rate** = fraction of tasks where the F2 LoopGuard tripped ≥1 time',
    '  when replaying the transcript (same tool+args repeats, failure repeats,',
    '  apply/revert ping-pong, spend-without-progress).',
    '- **Reproduce**: `sunday-eval run [--live] --out eval-results/<ts>` then',
    '  `sunday-eval scoreboard --runs eval-results --out docs/SCOREBOARD.md`.',
    '',
    '_Scores are pooled across repetitions; the pass-rate range shows run-to-run variance._',
    '',
  );
  return lines.join('\n');
}

/** Write the rendered scoreboard to disk (creates parent dirs). */
export function writeScoreboard(
  scores: ModelScore[],
  outPath: string,
  opts: { generatedAt?: string; packVersion?: number } = {},
): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderScoreboard(scores, opts));
}

export type { TaskCategory };
