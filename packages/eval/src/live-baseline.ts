#!/usr/bin/env node
// sunday-eval live baseline (1.0-beta gate #3).
//
// Runs the benchmark tasks against a REAL provider model through sundayd and
// records a per-release baseline: pass/fail, latency, and token usage per
// task. Writes JSON + Markdown reports.
//
// Usage:
//   node packages/eval/dist/live-baseline.js [--tasks id1,id2] [--model <id>] [--out dir]
//   pnpm --filter @sunday/eval eval:live-baseline
//
// Env:
//   OPENROUTER_API_KEY / GROQ_API_KEY — provider credentials (either one).
//     With NEITHER set the script prints "live baseline skipped: no keys"
//     and exits 0 — safe to run in CI without secrets.
//   SUNDAY_EVAL_MODEL — optional model override passed to chat/send.
//   SUNDAY_EVAL_TASK_TIMEOUT_MS — per-task wall-clock budget (default 600000).
//
// Pass targets (documented in docs/EVAL.md):
//   - task pass rate            >= 80%
//   - mean tool reliability     >= 95%
//   - no task exceeds the per-task timeout
// Exit code is 1 when targets are not met (0 on skip or when met).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveBaselineAdapter, detectProviderKeys } from './adapters.js';
import { TASKS } from './tasks.js';
import type { BaselineReport, BaselineTaskResult, BaselineTargets } from './types.js';

export const BASELINE_TARGETS: BaselineTargets = {
  minPassRate: 0.8,
  minMeanToolReliability: 0.95,
  maxTaskDurationMs: 600_000,
};

function flag(name: string, argv: string[]): string | undefined {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i === -1) return undefined;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

function formatTimeout(ms: number): string {
  return ms % 60000 === 0 ? `${ms / 60000} min` : `${(ms / 1000).toFixed(0)}s`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function evaluateTargets(report: Omit<BaselineReport, 'targetsMet' | 'targetNotes'>): {
  targetsMet: boolean;
  targetNotes: string[];
} {
  const notes: string[] = [];
  const passRate = report.total === 0 ? 0 : report.passed / report.total;
  if (passRate < report.targets.minPassRate) {
    notes.push(
      `pass rate ${(passRate * 100).toFixed(1)}% below target ${(report.targets.minPassRate * 100).toFixed(0)}%`,
    );
  }
  if (report.meanToolReliability < report.targets.minMeanToolReliability) {
    notes.push(
      `mean tool reliability ${(report.meanToolReliability * 100).toFixed(1)}% below target ${(report.targets.minMeanToolReliability * 100).toFixed(0)}%`,
    );
  }
  for (const t of report.tasks) {
    if (t.durationMs > report.targets.maxTaskDurationMs) {
      notes.push(`task ${t.taskId} exceeded timeout (${t.durationMs}ms > ${report.targets.maxTaskDurationMs}ms)`);
    }
  }
  return { targetsMet: notes.length === 0, targetNotes: notes };
}

function renderBaselineMarkdown(r: BaselineReport): string {
  const lines = [
    `# Sunday live-model baseline — ${r.adapter}${r.model ? ` (${r.model})` : ''}`,
    '',
    `Started: ${r.startedAt} · duration ${(r.durationMs / 1000).toFixed(1)}s`,
    `Provider keys present: ${r.providerKeys.join(', ') || 'none'}`,
    '',
    `**${r.passed}/${r.total} tasks passed** (${((r.passed / Math.max(1, r.total)) * 100).toFixed(1)}%) · ` +
      `mean tool reliability ${(r.meanToolReliability * 100).toFixed(1)}%`,
    `Tokens: ${r.totalInputTokens} in / ${r.totalOutputTokens} out · ` +
      `latency p50 ${r.latencyP50Ms}ms / p95 ${r.latencyP95Ms}ms`,
    '',
    '## Pass targets',
    '',
    `| Target | Value | Result |`,
    `|---|---|---|`,
    `| Task pass rate ≥ ${(r.targets.minPassRate * 100).toFixed(0)}% | ${((r.passed / Math.max(1, r.total)) * 100).toFixed(1)}% | ${r.passed / Math.max(1, r.total) >= r.targets.minPassRate ? '✅' : '❌'} |`,
    `| Mean tool reliability ≥ ${(r.targets.minMeanToolReliability * 100).toFixed(0)}% | ${(r.meanToolReliability * 100).toFixed(1)}% | ${r.meanToolReliability >= r.targets.minMeanToolReliability ? '✅' : '❌'} |`,
    `| No task over ${formatTimeout(r.targets.maxTaskDurationMs)} | ${r.tasks.every((t) => t.durationMs <= r.targets.maxTaskDurationMs) ? 'yes' : 'no'} | ${r.tasks.every((t) => t.durationMs <= r.targets.maxTaskDurationMs) ? '✅' : '❌'} |`,
    '',
    r.targetsMet ? '**Targets met ✅**' : `**Targets NOT met ❌** — ${r.targetNotes.join('; ')}`,
    '',
    '## Tasks',
    '',
    '| Task | Pass | Tool calls | Reliability | Time | In tok | Out tok | Notes |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const t of r.tasks) {
    lines.push(
      `| ${t.taskId} | ${t.pass ? '✅' : '❌'} | ${t.validCalls}/${t.toolCalls} | ${(t.toolReliability * 100).toFixed(0)}% | ${t.durationMs}ms | ${t.inputTokens} | ${t.outputTokens} | ${t.notes} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const keys = detectProviderKeys();
  if (keys.length === 0) {
    // Graceful skip — never fail CI/release tooling just because no provider
    // credentials are configured on this machine.
    console.log('live baseline skipped: no keys (set OPENROUTER_API_KEY or GROQ_API_KEY to run)');
    return;
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const date = startedAt.slice(0, 10);
  const model = process.env.SUNDAY_EVAL_MODEL?.trim() || undefined;
  const taskTimeoutMs = Number(process.env.SUNDAY_EVAL_TASK_TIMEOUT_MS ?? BASELINE_TARGETS.maxTaskDurationMs);
  const cliPath = new URL('../../sundayd/dist/cli.js', import.meta.url).pathname;
  const adapter = new LiveBaselineAdapter(cliPath, { taskTimeoutMs, model });

  const onlyTasks = flag('--tasks', argv)?.split(',').map((s) => s.trim()).filter(Boolean);
  const tasks = onlyTasks ? TASKS.filter((t) => onlyTasks.includes(t.id)) : TASKS;
  if (tasks.length === 0) throw new Error('no eval tasks selected');

  const results: BaselineTaskResult[] = [];
  for (const task of tasks) {
    const taskStart = Date.now();
    const root = mkdtempSync(join(tmpdir(), `sunday-baseline-${task.id}-`));
    try {
      await task.setup(root);
      const { transcript, usage } = await adapter.runTaskDetailed(task, root);
      const { pass, notes } = task.check(root, transcript);
      const validCalls = transcript.filter((c) => c.valid).length;
      results.push({
        taskId: task.id,
        title: task.title,
        pass,
        notes,
        toolCalls: transcript.length,
        validCalls,
        toolReliability: transcript.length === 0 ? 1 : validCalls / transcript.length,
        durationMs: Date.now() - taskStart,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
      console.log(
        `[${task.id}] ${pass ? 'PASS' : 'FAIL'} ` +
          `${Date.now() - taskStart}ms · ${usage.inputTokens}/${usage.outputTokens} tok · ${notes}`,
      );
    } catch (e) {
      results.push({
        taskId: task.id,
        title: task.title,
        pass: false,
        notes: `harness error: ${(e as Error).message}`,
        toolCalls: 0,
        validCalls: 0,
        toolReliability: 0,
        durationMs: Date.now() - taskStart,
        inputTokens: 0,
        outputTokens: 0,
      });
      console.log(`[${task.id}] ERROR ${(e as Error).message}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const latencies = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const partial: Omit<BaselineReport, 'targetsMet' | 'targetNotes'> = {
    adapter: adapter.name,
    model,
    providerKeys: keys,
    startedAt,
    durationMs: Date.now() - started,
    tasks: results,
    passed,
    total: results.length,
    meanToolReliability:
      results.length === 0 ? 0 : results.reduce((s, r) => s + r.toolReliability, 0) / results.length,
    totalInputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
    totalOutputTokens: results.reduce((s, r) => s + r.outputTokens, 0),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    targets: { ...BASELINE_TARGETS, maxTaskDurationMs: taskTimeoutMs },
  };
  const { targetsMet, targetNotes } = evaluateTargets(partial);
  const report: BaselineReport = { ...partial, targetsMet, targetNotes };

  // Machine-readable + human-readable reports next to the fake-scripted ones.
  const outDir = flag('--out', argv) ?? join(process.cwd(), 'eval-results', `baseline-${startedAt.replace(/[:.]/g, '-')}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const md = renderBaselineMarkdown(report);
  writeFileSync(join(outDir, 'RESULTS.md'), md);
  // Per-release baseline doc (release evidence for gate #3), anchored at the
  // repo root regardless of the working directory the script is run from.
  const repoRoot = new URL('../../../', import.meta.url).pathname;
  const docsPath = join(repoRoot, 'docs', `eval-baseline-${date}.md`);
  try {
    writeFileSync(docsPath, md);
    console.log(`wrote ${docsPath}`);
  } catch (e) {
    console.log(`note: could not write ${docsPath}: ${(e as Error).message}`);
  }

  console.log(
    `\n${report.passed}/${report.total} passed · reliability ${(report.meanToolReliability * 100).toFixed(1)}% · ` +
      `${report.totalInputTokens}/${report.totalOutputTokens} tokens · targets ${targetsMet ? 'MET' : 'NOT MET'}`,
  );
  if (!targetsMet) {
    for (const n of targetNotes) console.log(`  - ${n}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
