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

**How to measure for the +10% gate** (needs a real VS Code install).
`scripts/vscode-startup-baseline.mjs` automates what it can and prints the
manual procedure when `code` is not on PATH:

```sh
node scripts/vscode-startup-baseline.mjs --trials=3
# → prints the manual Startup Performance procedure if VS Code is absent
```

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

Budget: **sundayd RSS ≤ 512MB after 1 hour of idle-ish use.** The method is
implemented as a runnable harness: `scripts/soak-test.mjs`.

```sh
# Full 1-hour release soak:
node scripts/soak-test.mjs --duration=60m --out=soak-report.json
# Short mode (harness smoke test):
node scripts/soak-test.mjs --duration=5m --workload-interval=15s
```

What the harness does:

1. Spawns `node --expose-gc packages/sundayd/dist/cli.js` (stdio JSON-RPC)
   and performs the `sunday/hello` handshake (also records cold-start ms).
2. Runs a representative **provider-free** workload every `--workload-interval`
   (default 30s): `session/create` → `session/list` → `tools/list` →
   `mcp/servers/list` → `daemon/status` → `session/close`. This exercises
   session persistence (a known accumulator), the tool catalogue, the MCP hub,
   and daemon status without needing provider API keys.
3. Samples child-process RSS and CPU every 60s via `ps`.
4. Writes a time-series JSON (`samples: [{t, rssMB, cpuPct}, …]`) plus a
   summary: max RSS, final RSS, back-half linear slope (MB/min), workload
   turn/error counts.
5. Verdict: **FAIL** if max RSS > 512MB, or if the back-half slope > 1MB/min
   (steady growth = leak even under the cap). Exit 0 = PASS, 1 = budget/leak,
   2 = harness error.

**Interpreting results:** a flat line under ~100MB after GC warmup is the
healthy shape (the 5-min idle soak settled at ~41.5MB). A rising slope in the
back half points at an accumulator — check the known suspects:
`CompletionOrchestrator.latencies` (capped at 1000), MCP call history,
session files (append-only per turn; bounded by session rotation).

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
| Extension activation +10% gate | VS Code Startup Performance (`scripts/vscode-startup-baseline.mjs`) | ❌ manual, on Windows target |
| 1h memory soak (scripted turns + idle) | `scripts/soak-test.mjs` | ❌ manual, release checklist (harness verified in 5m mode) |
| Screen-reader pass | human | ❌ manual (see ACCESSIBILITY.md) |

## Notes

- Builds/tests on the 7.7GB VM must stay sequential:
  `pnpm -r --workspace-concurrency=1` (parallel `tsc` OOMs). This pass used
  per-package `node_modules/.bin` directly (pnpm not on PATH).
- Webview bundles stay small: ui-chat 157KB / ui-manager 154KB JS (gzip
  ~50KB) — well under any webview budget; no action needed.
- The Agent Browser panel polls frames at 2fps only while visible
  (`updatePolling`); no background cost when hidden.
