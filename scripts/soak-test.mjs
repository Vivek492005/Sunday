#!/usr/bin/env node
/**
 * scripts/soak-test.mjs — sundayd 1-hour memory soak harness.
 *
 * Boots a real sundayd (stdio JSON-RPC), runs a representative workload
 * (session create/list/close cycles, tools/list, mcp/servers/list,
 * daemon/status), samples RSS/CPU every minute, and writes a time-series
 * JSON + summary report. Fails if RSS exceeds the 512MB budget or shows
 * sustained growth (leak signal) in the back half of the run.
 *
 * Usage:
 *   node scripts/soak-test.mjs [--duration=60m] [--out=soak-report.json]
 *                                [--sundayd=packages/sundayd/dist/cli.js]
 *                                [--workload-interval=30s]
 *
 * Short mode for smoke-testing the harness itself:
 *   node scripts/soak-test.mjs --duration=5m
 *
 * Duration suffixes: s (seconds), m (minutes), h (hours).
 * No provider API keys needed — the workload uses provider-free RPCs only.
 * Exit code: 0 = within budget, 1 = budget exceeded or leak detected,
 *            2 = harness/daemon error.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const RSS_BUDGET_MB = 512;

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(s);
  if (!m) throw new Error(`bad duration: ${s} (use e.g. 5m, 60m, 1h)`);
  const mult = { s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
  return Number(m[1]) * mult;
}

function parseArgs(argv) {
  const opts = {
    duration: '60m',
    out: 'soak-report.json',
    sundayd: path.join('packages', 'sundayd', 'dist', 'cli.js'),
    workloadInterval: '30s',
  };
  for (const a of argv) {
    const mm = /^--([a-zA-Z-]+)=(.+)$/.exec(a);
    if (!mm) throw new Error(`bad arg: ${a}`);
    const key = mm[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in opts)) throw new Error(`unknown option: --${mm[1]}`);
    opts[key] = mm[2];
  }
  return opts;
}

/** Minimal NDJSON JSON-RPC client over a child process's stdio. */
class RpcClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    proc.stdout.on('data', (d) => this.onData(d));
    proc.stderr.on('data', (d) => process.stderr.write(`[sundayd] ${d}`));
  }
  onData(d) {
    this.buf += d.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
      // notifications (no id) are ignored — soak doesn't need them
    }
  }
  call(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}

async function sampleMemory(pid) {
  // ps output: "<rss_kb> <%cpu>"
  const { stdout } = await execFileAsync('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)]);
  const [rssKb, cpuPct] = stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(rssKb)) throw new Error(`ps failed for pid ${pid}`);
  return { rssMB: rssKb / 1024, cpuPct: Number.isFinite(cpuPct) ? cpuPct : 0 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const durationMs = parseDuration(opts.duration);
  const workloadIntervalMs = parseDuration(opts.workloadInterval);
  const sundaydPath = path.resolve(opts.sundayd);
  if (!fs.existsSync(sundaydPath)) {
    console.error(`sundayd not found at ${sundaydPath} — run the package build first`);
    process.exit(2);
  }

  console.log(`[soak] spawning ${sundaydPath}`);
  const t0 = Date.now();
  const proc = spawn(process.execPath, ['--expose-gc', sundaydPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = new RpcClient(proc);
  const samples = [];
  let workloadTurns = 0;
  let workloadErrors = 0;

  const exited = new Promise((resolve) => proc.on('exit', (code, sig) => resolve({ code, sig })));

  try {
    // Handshake.
    const hello = await rpc.call('sunday/hello', {
      protocolVersion: 1,
      client: { name: 'soak-test', version: '0.1.0', os: process.platform },
    });
    console.log(`[soak] hello ok (protocol ${hello?.protocolVersion ?? '?'})`);
    const coldStartMs = Date.now() - t0;
    console.log(`[soak] cold start: ${coldStartMs}ms`);

    const deadline = Date.now() + durationMs;
    let nextSample = Date.now();
    let nextWorkload = Date.now();

    while (Date.now() < deadline) {
      const now = Date.now();

      if (now >= nextWorkload) {
        nextWorkload = now + workloadIntervalMs;
        try {
          // Representative provider-free workload: exercises session
          // persistence (a known accumulator), tool catalogue, MCP hub,
          // and daemon status in one burst.
          const { session } = await rpc.call('session/create', { title: `soak-${workloadTurns}` });
          await rpc.call('session/list', {});
          await rpc.call('tools/list', {});
          await rpc.call('mcp/servers/list', {});
          await rpc.call('daemon/status', {});
          await rpc.call('session/close', { sessionId: session.id });
          workloadTurns++;
        } catch (e) {
          workloadErrors++;
          console.error(`[soak] workload error: ${e.message}`);
        }
      }

      if (now >= nextSample) {
        nextSample = now + 60_000;
        try {
          const mem = await sampleMemory(proc.pid);
          samples.push({ t: Math.round((now - t0) / 1000), rssMB: +mem.rssMB.toFixed(1), cpuPct: +mem.cpuPct.toFixed(1) });
          const last = samples[samples.length - 1];
          console.log(`[soak] t=${last.t}s rss=${last.rssMB}MB cpu=${last.cpuPct}%`);
        } catch (e) {
          console.error(`[soak] sample error: ${e.message}`);
          break; // daemon likely gone
        }
      }

      await sleep(1000);
      if (proc.exitCode !== null) throw new Error(`sundayd exited early (code ${proc.exitCode})`);
    }
  } catch (e) {
    console.error(`[soak] FATAL: ${e.message}`);
    proc.kill('SIGKILL');
    process.exit(2);
  }

  // Shutdown cleanly.
  try { await rpc.call('sunday/shutdown', {}, 10_000); } catch { /* best effort */ }
  await Promise.race([exited, sleep(5000)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');

  // Analysis.
  const rss = samples.map((s) => s.rssMB);
  const maxRss = rss.length ? Math.max(...rss) : 0;
  const lastRss = rss.length ? rss[rss.length - 1] : 0;
  // Leak signal: linear slope over the back half of the run (MB/min).
  let slope = 0;
  if (samples.length >= 4) {
    const half = samples.slice(Math.floor(samples.length / 2));
    const n = half.length;
    const xs = half.map((s) => s.t / 60);
    const ys = half.map((s) => s.rssMB);
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    slope = den ? num / den : 0;
  }

  const overBudget = maxRss > RSS_BUDGET_MB;
  const leaking = slope > 1.0; // >1MB/min sustained growth in back half
  const report = {
    generatedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - t0) / 1000),
    budgetMB: RSS_BUDGET_MB,
    samples,
    summary: {
      samples: samples.length,
      maxRssMB: +maxRss.toFixed(1),
      finalRssMB: +lastRss.toFixed(1),
      backHalfSlopeMBPerMin: +slope.toFixed(3),
      workloadTurns,
      workloadErrors,
      overBudget,
      leaking,
      verdict: overBudget ? 'FAIL: over budget' : leaking ? 'FAIL: leak detected' : 'PASS',
    },
  };
  fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));
  console.log(`[soak] report → ${opts.out}`);
  console.log(`[soak] max RSS ${report.summary.maxRssMB}MB (budget ${RSS_BUDGET_MB}MB), ` +
    `slope ${report.summary.backHalfSlopeMBPerMin}MB/min → ${report.summary.verdict}`);

  process.exit(overBudget || leaking ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
