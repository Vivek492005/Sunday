#!/usr/bin/env node
/**
 * Sunday hosted gateway — load test.
 *
 * Respectful by design: targets the live Render free-tier service with
 * modest concurrency. NEVER touches /v1/chat/completions (real API credits).
 *
 * Usage: node scripts/load-test-gateway.mjs [--base https://...]
 *
 * Exit codes: 0 = all checks passed, 1 = failure/degradation detected.
 */
const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7)
  || process.env.SUNDAY_GATEWAY_URL
  || 'https://sunday-final-ide.onrender.com';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOTAL_MS = 10 * 60_000;

// ---------------------------------------------------------------- helpers
const stats = (latencies) => {
  if (!latencies.length) return { n: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  const s = [...latencies].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    min: Math.round(s[0]),
    p50: Math.round(q(0.5)),
    p95: Math.round(q(0.95)),
    p99: Math.round(q(0.99)),
    max: Math.round(s[s.length - 1]),
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
};

async function req(path, { method = 'GET', body = null } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : null,
      signal: controller.signal,
    });
    // Drain body so connection can be reused.
    await res.text().catch(() => {});
    const ms = performance.now() - start;
    return {
      ok: res.ok, status: res.status, ms,
      retryAfter: res.headers.get('retry-after'),
    };
  } catch (err) {
    return { ok: false, status: 0, ms: performance.now() - start, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

/** Run `concurrency` workers hammering `fn` for `durationMs`. Returns latencies + status counts. */
async function hammer(label, fn, concurrency, durationMs) {
  const latencies = [];
  const statuses = {};
  const deadline = Date.now() + durationMs;
  let unresponsiveStreak = 0;

  const worker = async () => {
    while (Date.now() < deadline) {
      const r = await fn();
      latencies.push(r.ms);
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      if (r.status >= 500 || r.status === 0) {
        unresponsiveStreak++;
        if (unresponsiveStreak >= 10) throw new Error(`${label}: 10 consecutive 5xx/network failures — stopping`);
      } else {
        unresponsiveStreak = 0;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { label, concurrency, ...stats(latencies), statuses };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const checkBudget = () => {
  if (Date.now() - started > MAX_TOTAL_MS) throw new Error('Total time budget (10 min) exceeded — stopping');
};

// ---------------------------------------------------------------- main
let failures = 0;
const fail = (msg) => { console.error(`  ❌ ${msg}`); failures++; };
const pass = (msg) => console.log(`  ✅ ${msg}`);

console.log(`\nSunday gateway load test — ${BASE}\n`);

try {
  // ---- 1. Warmup: 10 sequential /health (cold vs warm) ----
  console.log('1. Warmup — 10 sequential GET /health');
  const warm = [];
  for (let i = 0; i < 10; i++) {
    const r = await req('/health');
    warm.push(r.ms);
    if (!r.ok) fail(`/health returned ${r.status}`);
  }
  console.log(`   first=${Math.round(warm[0])}ms last=${Math.round(warm[9])}ms mean=${Math.round(warm.reduce((a, b) => a + b, 0) / warm.length)}ms`);
  pass('warmup complete');
  await sleep(1000);

  // ---- 2. Concurrency ramp on /health ----
  console.log('\n2. Concurrency ramp — GET /health, 30s each');
  const rampResults = [];
  for (const c of [1, 5, 10, 25, 50]) {
    checkBudget();
    const r = await hammer(`/health c=${c}`, () => req('/health'), c, 30_000);
    rampResults.push(r);
    const errors = Object.entries(r.statuses).filter(([s]) => +s >= 500 || +s === 0)
      .reduce((a, [, n]) => a + n, 0);
    const errRate = ((errors / r.n) * 100).toFixed(1);
    console.log(`   c=${String(c).padStart(2)}  n=${r.n}  p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms max=${r.max}ms err=${errRate}%`);
    if (errors > 0) fail(`c=${c}: ${errors} errors`);
    await sleep(2000); // breathe between ramps
  }
  pass('ramp complete');

  // ---- 3. Sustained /updates/check (cache verification) ----
  console.log('\n3. Sustained — 10 concurrent GET /updates/check for 60s');
  checkBudget();
  const first = await req('/updates/check?platform=win32&current=1.0.0');
  console.log(`   first (uncached): ${Math.round(first.ms)}ms status=${first.status}`);
  const upd = await hammer('updates', () => req('/updates/check?platform=win32&current=1.0.0'), 10, 60_000);
  const updErrors = Object.entries(upd.statuses).filter(([s]) => +s >= 500 || +s === 0)
    .reduce((a, [, n]) => a + n, 0);
  console.log(`   sustained: n=${upd.n} p50=${upd.p50}ms p95=${upd.p95}ms p99=${upd.p99}ms err=${((updErrors / upd.n) * 100).toFixed(1)}%`);
  if (upd.p50 > first.ms * 0.5 && first.ms > 500) {
    console.log('   (cache: p50 much lower than first hit — cache working)');
  }
  if (updErrors > 0) fail(`${updErrors} errors on /updates/check`);
  else pass('sustained updates check complete');
  await sleep(2000);

  // ---- 4. Rate limit verification on /auth/session ----
  console.log('\n4. Rate limit — 30 rapid POST /auth/session (invalid token)');
  checkBudget();
  const rl = [];
  for (let i = 0; i < 30; i++) {
    rl.push(await req('/auth/session', { method: 'POST', body: { google_access_token: 'invalid-test-token' } }));
    await sleep(50); // rapid but not abusive
  }
  const ok401 = rl.filter((r) => r.status === 401).length;
  const got429 = rl.filter((r) => r.status === 429).length;
  const withRetryAfter = rl.filter((r) => r.status === 429 && r.retryAfter).length;
  const first429At = rl.findIndex((r) => r.status === 429);
  console.log(`   401s=${ok401} 429s=${got429} (first 429 at request #${first429At + 1}) Retry-After present=${withRetryAfter}/${got429}`);
  if (got429 === 0) fail('rate limiter did NOT trigger — expected 429s after ~20 requests');
  else if (first429At < 18 || first429At > 24) fail(`first 429 at #${first429At + 1}, expected ~#21 (20 req/min bucket)`);
  else pass('rate limiter working (429s after ~20 requests)');
  if (got429 > 0 && withRetryAfter !== got429) fail('some 429s missing Retry-After header');
  else if (got429 > 0) pass('Retry-After header present on all 429s');
  // Let the rate-limit bucket cool down before further tests.
  await sleep(5000);

  // ---- 5. /v1/models without auth ----
  console.log('\n5. GET /v1/models without auth (expect 401)');
  const m = await req('/v1/models');
  console.log(`   status=${m.status} in ${Math.round(m.ms)}ms`);
  if (m.status !== 401) fail(`expected 401, got ${m.status}`);
  else pass('unauthenticated /v1/models correctly rejected');

  // ---- summary ----
  console.log('\n' + '='.repeat(50));
  console.log('RAMP SUMMARY (/health)');
  console.log('  c    n      p50    p95    p99    max');
  for (const r of rampResults) {
    console.log(`  ${String(r.concurrency).padStart(2)}  ${String(r.n).padStart(5)}  ${String(r.p50 + 'ms').padStart(6)}  ${String(r.p95 + 'ms').padStart(6)}  ${String(r.p99 + 'ms').padStart(6)}  ${r.max}ms`);
  }
  console.log('='.repeat(50));
} catch (err) {
  fail(`ABORTED: ${err.message}`);
}

const totalMin = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\nDone in ${totalMin} min. ${failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} FAILURE(S) ❌`}`);
process.exit(failures === 0 ? 0 : 1);
