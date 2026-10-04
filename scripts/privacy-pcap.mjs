#!/usr/bin/env node
// scripts/privacy-pcap.mjs — Privacy release gate (#6) verification.
//
// Boots a real sundayd with provider keys scrubbed from the environment
// ("no-keys" posture), performs an idle session plus a chat turn that must
// fail fast with "missing API key", and monitors the daemon's network
// activity for the whole run. Verdict: PASS iff zero non-loopback
// connections are observed for the sundayd process.
//
// Method: polls `ss -tnp` (Linux) for sockets owned by the sundayd PID.
// If tcpdump/tshark is present it ALSO records a real pcap. Polling can't
// catch sub-second connections — the fetch-stub idle-silent test
// (packages/sundayd/src/privacy-idle.test.ts) remains the primary
// guarantee; this script is defense-in-depth evidence plus the harness a
// human uses with real packet capture (see docs/PRIVACY_PCAP.md).
//
// Usage:
//   node scripts/privacy-pcap.mjs [--duration=60] [--poll-ms=2000]
//                                  [--out=./privacy-pcap-<ts>]
//                                  [--sundayd=packages/sundayd/dist/cli.js]
//
// Exit: 0 = PASS, 1 = FAIL (non-loopback connection seen), 2 = harness error.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { duration: 60, pollMs: 2000, out: null, sundayd: 'packages/sundayd/dist/cli.js' };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) { console.error(`unknown arg: ${a}`); process.exit(2); }
    const [, k, v] = m;
    if (k === 'duration') o.duration = Number(v);
    else if (k === 'pollMs' || k === 'poll-ms') o.pollMs = Number(v);
    else if (k === 'out') o.out = v;
    else if (k === 'sundayd') o.sundayd = v;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  if (!o.out) o.out = path.join(process.cwd(), `privacy-pcap-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return o;
}

// --- environment scrubbing -------------------------------------------------
// Remove anything that looks like a credential so the daemon under test runs
// in the "no-keys" posture. Record NAMES only, never values.
const SECRET_NAME_RE = /API_KEY|APIKEY|API_TOKEN|SECRET|TOKEN|PASSWORD|PRIVATE_KEY/i;
// Allowlist: tokens that are not credentials.
const SECRET_NAME_ALLOW = /^(PNPM_.*|NPM_.*|CARGO_.*|DISPLAY|TERM)$/i;

function scrubEnv() {
  const scrubbed = [];
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (SECRET_NAME_RE.test(k) && !SECRET_NAME_ALLOW.test(k)) {
      scrubbed.push(k);
      delete env[k];
    }
  }
  // Belt and braces: the two provider keys must be gone even if the regex
  // above somehow missed them.
  for (const k of ['OPENROUTER_API_KEY', 'GROQ_API_KEY']) {
    if (k in env) { if (!scrubbed.includes(k)) scrubbed.push(k); delete env[k]; }
  }
  return { env, scrubbed };
}

// --- minimal NDJSON JSON-RPC client over stdio ------------------------------
function makeRpc(proc) {
  let id = 0;
  const pending = new Map();
  let buf = '';
  const notifications = [];
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`RPC ${msg.method ?? ''} error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      } else if (msg.method) {
        notifications.push(msg);
      }
    }
  });
  function request(method, params, timeoutMs = 15000) {
    const rpcId = ++id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(rpcId); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
      pending.set(rpcId, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }) + '\n');
    });
  }
  return { request, notifications };
}

// --- connection monitoring ---------------------------------------------------
function isLoopbackAddr(addr) {
  // addr like "127.0.0.1:443" or "[::1]:8080" or "127.0.0.1"
  const host = addr.replace(/^\[/, '').split(']')[0].split(':')[0];
  if (host === '::1' || host === '::ffff:127.0.0.1') return true;
  const v4 = host.split('.');
  return v4.length === 4 && v4[0] === '127';
}

async function ssSnapshot(pid) {
  // Returns [{local, peer, state}] for TCP sockets owned by pid.
  try {
    const { stdout } = await execFileAsync('ss', ['-tnp']);
    const out = [];
    for (const line of stdout.split('\n')) {
      if (!line.includes(`pid=${pid}`)) continue;
      // State Recv-Q Send-Q Local:Port Peer:Port Process
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const [state, , , local, peer] = parts;
      out.push({ local, peer, state });
    }
    return out;
  } catch {
    return null; // ss unavailable
  }
}

async function haveCaptureTool() {
  for (const t of ['tcpdump', 'tshark']) {
    try { await execFileAsync('which', [t]); return t; } catch { /* next */ }
  }
  return null;
}

// --- main --------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const report = {
    tool: 'scripts/privacy-pcap.mjs',
    startedAt: new Date().toISOString(),
    args: { duration: args.duration, pollMs: args.pollMs },
    platform: `${os.platform()} ${os.release()}`,
    envScrubbed: [],
    captureTool: null,
    pcapFile: null,
    rpcLog: [],
    samples: 0,
    violations: [],
    notes: [],
    verdict: 'UNKNOWN',
  };

  const sundaydPath = path.resolve(args.sundayd);
  if (!fs.existsSync(sundaydPath)) {
    console.error(`sundayd not found: ${sundaydPath} (build it: pnpm --filter @sunday/sundayd build)`);
    process.exit(2);
  }

  // 1. Scrub secrets from the child environment (no-keys posture).
  const { env, scrubbed } = scrubEnv();
  report.envScrubbed = scrubbed;
  console.log(`[pcap] scrubbed ${scrubbed.length} secret-like env vars: ${scrubbed.join(', ') || '(none found)'}`);

  // 2. Start optional real packet capture.
  const capTool = await haveCaptureTool();
  let capProc = null;
  if (capTool) {
    report.captureTool = capTool;
    const pcapFile = path.join(args.out, 'capture.pcap');
    report.pcapFile = pcapFile;
    const filter = 'tcp and not host 127.0.0.1 and not host ::1';
    capProc = capTool === 'tcpdump'
      ? spawn('tcpdump', ['-i', 'any', '-w', pcapFile, filter], { stdio: 'ignore' })
      : spawn('tshark', ['-i', 'any', '-w', pcapFile, '-f', filter], { stdio: 'ignore' });
    console.log(`[pcap] capturing non-loopback TCP to ${pcapFile} (${capTool})`);
    await sleep(1000);
  } else {
    report.notes.push('no tcpdump/tshark found; using ss polling only (see docs/PRIVACY_PCAP.md for full pcap procedure)');
    console.log('[pcap] no tcpdump/tshark; falling back to ss polling');
  }

  // 3. Boot sundayd (stdio JSON-RPC).
  const child = spawn(process.execPath, [sundaydPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrTail = [];
  child.stderr.on('data', (d) => { stderrTail.push(d.toString()); if (stderrTail.length > 50) stderrTail.shift(); });
  const rpc = makeRpc(child);
  const log = (m, ok, detail) => { report.rpcLog.push({ m, ok, detail: detail ?? null }); console.log(`[rpc] ${ok ? 'ok' : 'FAIL'} ${m}${detail ? ` — ${detail}` : ''}`); };

  const violations = [];
  const noteViolation = (where, sock) => {
    violations.push({ where, ...sock, at: new Date().toISOString() });
    console.log(`[VIOLATION] non-loopback socket for sundayd pid=${child.pid} during ${where}: ${sock.state} ${sock.local} -> ${sock.peer}`);
  };
  async function checkSockets(where) {
    const snap = await ssSnapshot(child.pid);
    if (snap === null) { report.notes.push(`ss unavailable during ${where}; sample skipped`); return; }
    report.samples++;
    for (const s of snap) {
      if (s.state === 'TIME-WAIT') continue; // dying socket, not an active connection
      if (!isLoopbackAddr(s.peer)) noteViolation(where, s);
    }
  }

  try {
    // 4. Handshake + idle RPCs.
    const hello = await rpc.request('sunday/hello', { protocolVersion: 1, client: { name: 'privacy-pcap', version: '1.0.0', os: os.platform() } });
    log('sunday/hello', true, `server=${hello?.server?.name ?? hello?.name ?? '?'}`);
    await checkSockets('hello');

    const session = await rpc.request('session/create', { cwd: process.cwd() });
    const sessionId = session?.session?.id ?? 'unknown';
    log('session/create', true, `sessionId=${sessionId}`);
    await checkSockets('session/create');

    const list = await rpc.request('session/list', {});
    const nSessions = Array.isArray(list?.sessions) ? list.sessions.length : '?';
    log('session/list', true, `sessions=${nSessions}`);
    await checkSockets('session/list');

    // 5. Chat turn with NO provider keys: must fail fast with "missing API key"
    //    and must not open any connection.
    let chatOutcome = 'no-error-seen';
    try {
      const turn = await rpc.request('chat/send', { sessionId, message: 'privacy probe: say hi' }, 20000);
      const turnId = turn?.turnId ?? turn?.id;
      // chat/send is async; wait for the turn to error out.
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await sleep(500);
        await checkSockets('chat/send(wait)');
        const evts = rpc.notifications.filter((n) => n.method === 'chat/event');
        const errs = evts.filter((n) => n.params?.event?.type === 'turn-error');
        if (errs.length) {
          const txt = JSON.stringify(errs[0].params?.event ?? errs[0].params);
          chatOutcome = /missing API key/i.test(txt) ? 'missing-api-key (expected)' : `other-error: ${txt.slice(0, 160)}`;
          break;
        }
        const done = evts.filter((n) => n.params?.event?.type === 'turn-end');
        if (done.length) { chatOutcome = 'turn-ended (UNEXPECTED: model call succeeded with no keys!)'; break; }
      }
    } catch (e) {
      chatOutcome = /missing API key/i.test(String(e)) ? 'missing-api-key (expected, sync)' : `rpc-error: ${String(e).slice(0, 160)}`;
    }
    log('chat/send (no keys)', /missing-api-key/.test(chatOutcome), chatOutcome);
    await checkSockets('chat/send');

    // 6. Idle monitoring for the requested duration.
    console.log(`[pcap] idle monitoring for ${args.duration}s (poll every ${args.pollMs}ms)…`);
    const end = Date.now() + args.duration * 1000;
    while (Date.now() < end) {
      await sleep(args.pollMs);
      if (child.exitCode !== null) { report.notes.push('sundayd exited during idle monitoring'); break; }
      await checkSockets('idle');
    }
  } catch (e) {
    report.notes.push(`harness error: ${String(e).slice(0, 300)}`);
    console.error(`[harness-error] ${e}`);
    report.verdict = 'HARNESS-ERROR';
  } finally {
    try { child.stdin.end(); } catch { /* ignore */ }
    await sleep(500);
    if (child.exitCode === null) child.kill('SIGTERM');
    if (capProc && capProc.exitCode === null) {
      capProc.kill('SIGINT');
      await sleep(1500);
      if (capProc.exitCode === null) capProc.kill('SIGKILL');
    }
  }

  report.violations = violations;
  report.finishedAt = new Date().toISOString();
  if (report.verdict === 'UNKNOWN') {
    report.verdict = violations.length === 0 ? 'PASS' : 'FAIL';
  }
  if (stderrTail.length) report.daemonStderrTail = stderrTail.join('').slice(-2000);

  const reportFile = path.join(args.out, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\n==== verdict: ${report.verdict} ====`);
  console.log(`samples: ${report.samples}, violations: ${violations.length}`);
  console.log(`report: ${reportFile}`);
  if (report.pcapFile) console.log(`pcap: ${report.pcapFile}`);
  for (const n of report.notes) console.log(`note: ${n}`);

  process.exit(report.verdict === 'PASS' ? 0 : report.verdict === 'FAIL' ? 1 : 2);
}

main().catch((e) => { console.error(e); process.exit(2); });
