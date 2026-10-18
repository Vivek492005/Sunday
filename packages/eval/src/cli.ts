#!/usr/bin/env node
// sunday-eval CLI: run the benchmark harness.
//
//   sunday-eval run [--live] [--tasks a,b] [--out dir]
//   sunday-eval scoreboard --runs <dir> --out <markdown> [--feed <json>]
//
// Default uses the scripted fake adapter (no API keys). --live drives a real
// model through sundayd over stdio (needs provider credentials configured).
//
// `scoreboard` reads every */report.json under --runs (written by `run` or
// by live-baseline) and renders the public F12 scoreboard Markdown plus the
// F3 router quality-tier feed JSON.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakeModelAdapter, SundaydAdapter, isLiveRequested } from './adapters.js';
import { runBenchmark } from './runner.js';
import { TASKS } from './tasks.js';
import { TASK_PACK_VERSION } from './types.js';
import {
  buildScoreboard,
  estimateTaskCostUsd,
  writeScoreboard,
  type ScoreboardRun,
  type ScoreboardTask,
} from './scoreboard.js';
import { writeQualityFeed } from './routerFeed.js';

const [, , cmd, ...rest] = process.argv;

function flag(name: string): string | undefined {
  const i = rest.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i === -1) return undefined;
  const a = rest[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : rest[i + 1];
}

function usage(): void {
  console.log('usage:');
  console.log('  sunday-eval run [--live] [--tasks id1,id2] [--out dir]');
  console.log('  sunday-eval scoreboard --runs <dir> --out <markdown> [--feed <json>]');
  console.log(`available tasks: ${TASKS.map((t) => t.id).join(', ')}`);
}

interface StoredTask {
  taskId: string;
  pass: boolean;
  toolReliability: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  score?: {
    requests?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    loopTriggers?: number;
  };
}

interface StoredReport {
  adapter?: string;
  model?: string;
  startedAt?: string;
  tasks?: StoredTask[];
}

/** Find the task category for a report task id (reports may predate categories). */
function categoryFor(taskId: string): string | undefined {
  const t = TASKS.find((t) => t.id === taskId);
  return t?.category as string | undefined;
}

function reportToRun(file: string, report: StoredReport): ScoreboardRun | null {
  if (!report || !Array.isArray(report.tasks) || report.tasks.length === 0) {
    console.warn(`scoreboard: skipping ${file} (no tasks)`);
    return null;
  }
  const model = report.model ?? report.adapter ?? 'unknown';
  const tasks: ScoreboardTask[] = report.tasks.map((t) => {
    const score = t.score ?? {};
    const inputTokens = t.inputTokens ?? score.inputTokens;
    const outputTokens = t.outputTokens ?? score.outputTokens;
    const costUsd =
      score.costUsd ?? estimateTaskCostUsd({ inputTokens, outputTokens }, model);
    return {
      taskId: t.taskId,
      category: categoryFor(t.taskId),
      pass: t.pass === true,
      toolReliability: typeof t.toolReliability === 'number' ? t.toolReliability : 0,
      durationMs: typeof t.durationMs === 'number' ? t.durationMs : 0,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(typeof score.requests === 'number' ? { requests: score.requests } : {}),
      ...(typeof score.loopTriggers === 'number' ? { loopTriggers: score.loopTriggers } : {}),
    };
  });
  return {
    model,
    adapter: report.adapter ?? 'unknown',
    packVersion: TASK_PACK_VERSION,
    startedAt: report.startedAt ?? new Date().toISOString(),
    tasks,
  };
}

async function runScoreboard(): Promise<void> {
  const runsDir = flag('--runs');
  const out = flag('--out');
  const feed = flag('--feed');
  if (!runsDir || !out) {
    console.error('scoreboard: --runs <dir> and --out <markdown> are required');
    process.exit(1);
  }
  const runs: ScoreboardRun[] = [];
  for (const entry of readdirSync(runsDir)) {
    const reportPath = join(runsDir, entry, 'report.json');
    let st;
    try {
      st = statSync(reportPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as StoredReport;
      const run = reportToRun(reportPath, report);
      if (run) runs.push(run);
    } catch (e) {
      console.warn(`scoreboard: skipping ${reportPath}: ${(e as Error).message}`);
    }
  }
  if (runs.length === 0) {
    console.error(`scoreboard: no report.json files found under ${runsDir}`);
    process.exit(1);
  }
  const scores = buildScoreboard(runs);
  writeScoreboard(scores, out);
  console.log(`scoreboard: ${scores.length} model(s), ${runs.length} run(s) → ${out}`);
  if (feed) {
    writeQualityFeed(scores, feed);
    console.log(`scoreboard: F3 router feed → ${feed}`);
  }
  for (const s of scores) {
    console.log(
      `  ${s.model}: ${(s.passRate * 100).toFixed(1)}% pass · ` +
        `${(s.meanToolReliability * 100).toFixed(1)}% reliable · ` +
        `loop-trigger ${ (s.loopTriggerRate * 100).toFixed(1)}%`,
    );
  }
}

async function main(): Promise<void> {
  if (cmd === 'scoreboard') {
    await runScoreboard();
    return;
  }
  if (cmd !== 'run') {
    usage();
    process.exit(cmd ? 1 : 0);
  }
  const live = flag('--live') !== undefined || isLiveRequested();
  const adapter = live
    ? new SundaydAdapter(new URL('../../sundayd/dist/cli.js', import.meta.url).pathname)
    : new FakeModelAdapter();
  const tasks = flag('--tasks')?.split(',').map((s) => s.trim()).filter(Boolean);
  const outDir = flag('--out');
  const report = await runBenchmark(adapter, { tasks, outDir });
  console.log(`\n${report.passed}/${report.total} passed · mean tool reliability ${(report.meanToolReliability * 100).toFixed(1)}%`);
  if (report.passed < report.total) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
