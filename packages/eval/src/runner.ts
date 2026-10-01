// @sunday/eval — benchmark runner.
//
// Runs every task in an isolated temp workspace, scores pass/fail plus
// tool-call reliability, and writes a JSON report and a Markdown results
// doc (the "write results doc" step from the plan).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASKS } from './tasks.js';
import type { BenchmarkReport, ModelAdapter, TaskResult } from './types.js';

export interface RunOptions {
  /** Subset of task ids; default = all. */
  tasks?: string[];
  /** Where to write report.json + RESULTS.md. Default: ./eval-results/<timestamp> */
  outDir?: string;
}

export async function runBenchmark(adapter: ModelAdapter, opts: RunOptions = {}): Promise<BenchmarkReport> {
  const tasks = opts.tasks ? TASKS.filter((t) => opts.tasks!.includes(t.id)) : TASKS;
  if (tasks.length === 0) throw new Error('no eval tasks selected');

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const results: TaskResult[] = [];

  for (const task of tasks) {
    const taskStart = Date.now();
    const root = mkdtempSync(join(tmpdir(), `sunday-eval-${task.id}-`));
    try {
      await task.setup(root);
      const transcript = await adapter.runTask(task, root);
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
      });
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
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const report: BenchmarkReport = {
    adapter: adapter.name,
    startedAt,
    durationMs: Date.now() - started,
    tasks: results,
    passed,
    total: results.length,
    meanToolReliability:
      results.length === 0 ? 0 : results.reduce((s, r) => s + r.toolReliability, 0) / results.length,
  };

  const outDir = opts.outDir ?? join(process.cwd(), 'eval-results', startedAt.replace(/[:.]/g, '-'));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'RESULTS.md'), renderMarkdown(report));
  return report;
}

function renderMarkdown(r: BenchmarkReport): string {
  const lines = [
    `# Sunday eval results — ${r.adapter}`,
    '',
    `Started: ${r.startedAt} · duration ${(r.durationMs / 1000).toFixed(1)}s`,
    `**${r.passed}/${r.total} tasks passed** · mean tool reliability ${(r.meanToolReliability * 100).toFixed(1)}%`,
    '',
    '| Task | Pass | Tool calls | Reliability | Time | Notes |',
    '|---|---|---|---|---|---|',
  ];
  for (const t of r.tasks) {
    lines.push(
      `| ${t.taskId} | ${t.pass ? '✅' : '❌'} | ${t.validCalls}/${t.toolCalls} | ${(t.toolReliability * 100).toFixed(0)}% | ${t.durationMs}ms | ${t.notes} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
