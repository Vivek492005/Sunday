#!/usr/bin/env node
// sunday-eval CLI: run the benchmark harness.
//
//   sunday-eval run [--live] [--tasks a,b] [--out dir]
//
// Default uses the scripted fake adapter (no API keys). --live drives a real
// model through sundayd over stdio (needs provider credentials configured).

import { FakeModelAdapter, SundaydAdapter, isLiveRequested } from './adapters.js';
import { runBenchmark } from './runner.js';
import { TASKS } from './tasks.js';

const [, , cmd, ...rest] = process.argv;

function flag(name: string): string | undefined {
  const i = rest.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i === -1) return undefined;
  const a = rest[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : rest[i + 1];
}

async function main(): Promise<void> {
  if (cmd !== 'run') {
    console.log('usage: sunday-eval run [--live] [--tasks id1,id2] [--out dir]');
    console.log(`available tasks: ${TASKS.map((t) => t.id).join(', ')}`);
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
