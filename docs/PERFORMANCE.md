# Performance

1.0-beta performance gates come from the design doc (§A.5): extension startup
within +10% of stock VS Code, a 1-hour memory budget for `sundayd`, and
autocomplete latency targets. This doc records the budgets, what was measured
in this pass, how to measure, and what is CI-gated vs. manual.

## Budgets

| Area | Budget (1.0-beta) | Status |
|---|---|---|
| Extension activation | ≤ +10% over stock VS Code startup | Manual (method below) |
| `sundayd` cold start (spawn → `sunday/hello` response) | ≤ 2s (internal; supports the startup gate) | Measured: median **824ms** |
| `sundayd` memory, 1h idle-ish session | RSS ≤ 512MB | Method validated; 5-min soak RSS flat at ~41.5MB (see below) |
| Autocomplete p50 (orchestrator overhead) | p50 < 150ms | CI-gated regression test (`completion.test.ts`) |
| Autocomplete end-to-end (real provider) | p50 < 1s on warm cache-free path | Manual (gateway-dependent) |

## Measured numbers (2026-10-01, Linux VM: 2 vCPU, 7.7GB RAM)

### sundayd cold start

Method: spawn `node packages/sundayd/dist/cli.js`, immediately send a
`sunday/hello` JSON-RPC request on stdio, measure wall time to the first
response. 5 trials:

| Trial | ms |
|---|---|
| 1 | 1012 |
| 2 | 824 |
| 3 | 855 |
| 4 | 488 |
| 5 | 494 |

**Median 824ms** (min 488, max 1012). Trials 4–5 are warm page-cache; trial 1
is fully cold. Reproduce:

```sh
node /tmp/sunday-harden/measure-startup.mjs   # 5-trial script used for the numbers above
```

The bulk of the ~0.8s is Node module load + MCP config setup (additive, never
fatal) + session store init. The handshake path itself is the extension's
"ready" signal (`SidecarManager.doStart` → `handshake` → status `ready`).

### Extension activation

Activation was inspected, not run under VS Code (no VS Code instance on this
VM). `activate()` in `packages/ext-agent/src/extension.ts` does:

1. Output channel + trust/secret plumbing (2 file reads + VS Code secret-store
   reads for `secret:` MCP refs — the only awaited I/O).
2. Synchronous registration: 5 webview providers, ~20 commands, status bar.
3. **Async, non-blocking sidecar autostart** — `manager.start()` is fired
   without awaiting; the activate promise resolves before `sundayd` is ready.
   Sidecar readiness is reported via the status-bar item.

So VS Code's reported activation time ≈ module load + step 2 (tens of ms) +
secret pre-resolution (bounded by disk/secret-store latency). The dominant
perceived cost — the ~0.8s sundayd cold start — happens in the background and
is surfaced in the status bar (`$(sync~spin) Sunday` → `$(check) Sunday`).

**How to measure for the +10% gate** (needs a real VS Code install):

```sh
code --prof-startup --disable-gpu   # open a workspace, then:
# Developer: Show Running Extensions → read "Activation" for sunday-agent
# Developer: Startup Performance → compare total startup vs. stock profile
```

Acceptance: `sunday-agent` activation time must not push total window startup
more than 10% above the same window with the extension disabled. Because the
sidecar autostart is non-blocking, this should hold with margin; re-measure
on Windows (the 1.0 target OS) where process spawn is costlier.

### Memory: 1-hour budget methodology

Budget: **sundayd RSS ≤ 512MB after 1 hour of idle-ish use.** A full hour was
not run on this VM; instead the *method* was validated with a 5-minute idle
soak, which is evidence for the method, not proof of the budget.

Soak method (script `/tmp/sunday-harden/soak.mjs`):

```sh
# 1. Start with GC exposed so a final snapshot is honest:
node --expose-gc packages/sundayd/dist/cli.js
# 2. Handshake (sunday/hello), then 1–2 cheap RPCs (ping).
# 3. Every 60s: record process RSS (ps -o rss=).
#    Optionally also force GC and take a heap snapshot:
node -e 'const v8=require("v8"); /* writeHeapSnapshot via inspector */'
# 4. After 60min: fail the run if RSS > 512MB or if the last-30min slope > 0
#    (steady growth = leak even under the cap).
```

A scripted variant should also exercise a realistic loop: N chat turns with
tool calls (drives the AgentLoop, session persistence, tool-result buffers),
then idle 30 minutes and check RSS returns to the idle baseline. Watch the
known accumulators: `CompletionOrchestrator.latencies` (capped at 1000 by
`latencyWindow`), MCP call history (capped at 50 in the panel query; check
server-side retention), session files (append-only per turn — expected
growth, but bounded by session rotation).

**5-minute soak result (idle, post-handshake):** RSS 98.8MB → GC settles to
**41.5MB flat** over the last 3 minutes (samples every 15s: 42.9, 42.9, 42.9,
42.9, 42.0, 42.0, 42.0, 41.8, 41.6, 41.6, 41.6, 41.6, 41.5, 41.5). No growth
signal; startup allocations are reclaimed. This does not cover a chat-heavy
hour — the scripted-turns soak is still owed.

### Autocomplete p50

`CompletionOrchestrator` already instruments provider latency into a sliding
window (`stats()` → p50/p95, emitted as the `sunday.completion.latency` metric
line). The CI gate added in this pass (`packages/sundayd/src/completion.test.ts`,
"latency budget (perf gate)") asserts **p50 < 150ms over 30 sequential
completions with an instant fake provider** — i.e. it bounds *sundayd-side*
overhead (debounce already fired, no cache, no network), not the provider.
Measured in-test p50 is ~0–1ms, so the 150ms ceiling has wide headroom and
will only trip on a real regression (e.g. a serialization hot loop).

Real provider latency is a gateway concern (model + network): track it via the
`sunday.completion.latency` stderr metric in production, p50 target < 1s on
the cache-free path. Not CI-gated (network-dependent).

## CI-gated vs manual

| Check | Where | CI |
|---|---|---|
| Autocomplete orchestrator overhead p50 < 150ms | `sundayd/src/completion.test.ts` | ✅ `vitest run` |
| A11y markup assertions | `ui-chat`/`ui-manager` `a11y.test.tsx`, `browserPanel`/`mcpView` tests | ✅ `vitest run` |
| sundayd cold-start ≤ 2s | `measure-startup.mjs` (manual script) | ❌ manual — add to release checklist |
| Extension activation +10% gate | VS Code Startup Performance | ❌ manual, on Windows target |
| 1h memory soak (scripted turns + idle) | `soak.mjs` pattern | ❌ manual, release checklist |
| Screen-reader pass | human | ❌ manual (see ACCESSIBILITY.md) |

## Notes

- Builds/tests on the 7.7GB VM must stay sequential:
  `pnpm -r --workspace-concurrency=1` (parallel `tsc` OOMs). This pass used
  per-package `node_modules/.bin` directly (pnpm not on PATH).
- Webview bundles stay small: ui-chat 157KB / ui-manager 154KB JS (gzip
  ~50KB) — well under any webview budget; no action needed.
- The Agent Browser panel polls frames at 2fps only while visible
  (`updatePolling`); no background cost when hidden.
