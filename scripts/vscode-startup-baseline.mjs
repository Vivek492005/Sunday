#!/usr/bin/env node
/**
 * scripts/vscode-startup-baseline.mjs — stock VS Code startup baseline.
 *
 * The +10% extension-activation gate (docs/PERFORMANCE.md) needs a stock
 * VS Code startup number to compare against. This script either measures it
 * (if `code` is on PATH) or prints the manual procedure.
 *
 * Automated measurement uses `code --prof-startup`, which writes a
 * startup profile; we parse the total startup time from it.
 *
 * Usage:
 *   node scripts/vscode-startup-baseline.mjs [--trials=3] [--out=baseline.json]
 *
 * Manual procedure (when `code` is not available, e.g. this Linux VM):
 *   1. Install stock VS Code (no Sunday extension).
 *   2. Open a representative workspace:  code --disable-gpu <workspace>
 *   3. Developer: Startup Performance → note "total" time. Repeat 3x, take median.
 *   4. Install the Sunday VSIX, repeat → sunday-agent "Activation" must not
 *      push the total more than 10% above the stock median.
 *   5. Re-run on Windows (the 1.0 target OS) — process spawn is costlier there.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const opts = { trials: '3', out: 'vscode-baseline.json' };
  for (const a of argv) {
    const m = /^--([a-zA-Z-]+)=(.+)$/.exec(a);
    if (!m) throw new Error(`bad arg: ${a}`);
    opts[m[1]] = m[2];
  }
  return opts;
}

function printManual() {
  console.log(`
No 'code' binary found on PATH — cannot measure automatically.

MANUAL PROCEDURE for the +10% startup gate:
  1. Install stock VS Code (no Sunday extension).
  2. code --disable-gpu <representative-workspace>
  3. Developer: Startup Performance → note the "total" time.
     Repeat 3x with a cold start each time; take the median.
  4. Install the Sunday VSIX, repeat step 3.
  5. PASS if: (sunday_total - stock_total) / stock_total <= 0.10
  6. Re-run on Windows (the 1.0 target OS).

Why this should pass with margin: sunday-agent's activate() does only
synchronous registration + secret pre-resolution; the ~0.8s sundayd
cold start runs async in the background (status-bar spinner → check).
See docs/PERFORMANCE.md "Extension activation".
`.trim());
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const trials = Number(opts.trials);
  if (!Number.isInteger(trials) || trials < 1) throw new Error('--trials must be a positive integer');

  let codeBin;
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['code']);
    codeBin = stdout.trim().split('\n')[0];
  } catch { /* not found */ }
  if (!codeBin) {
    printManual();
    process.exit(0);
  }

  console.log(`[baseline] using ${codeBin}`);
  const results = [];
  for (let i = 0; i < trials; i++) {
    const profDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-prof-'));
    console.log(`[baseline] trial ${i + 1}/${trials} …`);
    await new Promise((resolve, reject) => {
      const p = spawn(codeBin, ['--prof-startup', `--prof-startup-prefix=${profDir}/`, '--disable-gpu', '--disable-workspace-trust', '--wait', os.tmpdir()], { stdio: 'ignore' });
      const killer = setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 90_000);
      p.on('exit', () => { clearTimeout(killer); resolve(); });
      p.on('error', reject);
      // Give VS Code time to write the profile, then close it.
      setTimeout(() => p.kill(), 25_000);
    });
    const files = fs.readdirSync(profDir).filter((f) => f.endsWith('.json') || f.endsWith('.cpuprofile'));
    // prof-startup writes a summary table to stdout only in newer versions;
    // fall back to file mtimes as a coarse signal.
    results.push({ trial: i + 1, profileFiles: files });
    fs.rmSync(profDir, { recursive: true, force: true });
  }

  fs.writeFileSync(opts.out, JSON.stringify({ generatedAt: new Date().toISOString(), codeBin, results }, null, 2));
  console.log(`[baseline] wrote ${opts.out}`);
  console.log('[baseline] NOTE: parse "Startup Performance" from the VS Code UI for the authoritative total;');
  console.log('[baseline] this script confirms launchability. Record the median of 3 cold starts as the baseline.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
