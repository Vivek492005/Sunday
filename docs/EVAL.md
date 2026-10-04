# Eval harness (`@sunday/eval`)

Deterministic benchmark for the agent tool surface. Fourteen tasks — file I/O,
search, edit, multi-step edit+verify, terminal, git, orchestration planning,
parallel orchestration, browser policy, browser UI bug-fix — each with a
fixture setup, a scripted model transcript, and a checker that inspects the
resulting workspace.

## Run

```sh
pnpm --filter @sunday/eval eval
# or: node packages/eval/dist/cli.js run [--live] [--tasks id1,id2] [--out dir]
```

Default uses the **scripted fake adapter**: it replays each task's scripted
steps through the *real* `@sunday/tools` registry, so tool-call reliability is
genuinely measured — no API keys needed. The orchestration and browser-policy
tasks additionally assert against the real planner (`validatePlanUnits`) and
policy module (`BrowserPolicy`).

Output: `eval-results/<timestamp>/report.json` + `RESULTS.md`.

## Live-model mode

```sh
SUNDAY_EVAL_LIVE=1 node packages/eval/dist/cli.js run
```

Drives a real model through `sundayd` over stdio JSON-RPC (needs provider keys
configured, same as a normal run). Tool calls are harvested from `chat/event`
notifications. Use this for per-model baselines before a release.

## Browser tasks (fake driver vs real Chromium)

The browser eval tasks (`browser-policy`, `browser-seeded-ui-bug`) run against
the **fake driver** in CI and on this VM: scripted `browser_*` calls are
replayed through deterministic eval-local stubs
(`packages/eval/src/adapters.ts` — `browser_open`, `browser_snapshot`,
`browser_console`, `browser_verify_ui`, `browser_walkthrough`), and the
checkers assert real workspace side effects (the served page, the fixed file
on disk, `walkthrough.md` under `.sunday/artifacts/`). No Chromium is
launched, so these tasks are fully hermetic and pass with no API keys or
browser installs.

What the fake driver does **not** cover — and needs real Chromium:

- screencast frames (`browser/screencastFrame` notifications)
- video recording (`browser/recording/start|stop`)
- real page rendering, layout, and screenshot pixels

Run those on GitHub Actions (16 GB runners, free for public repos) with a
Playwright Chromium install before the browserd tests:

```yaml
- run: npx playwright install chromium
- run: pnpm --filter @sunday/browserd test
```

## Live-model baseline & pass targets (1.0-beta gate #3)

Per-release live baselines are recorded with:

```sh
node packages/eval/dist/live-baseline.js [--tasks id1,id2] [--model <id>] [--out dir]
# or: pnpm --filter @sunday/eval eval:live-baseline
```

- Requires `OPENROUTER_API_KEY` or `GROQ_API_KEY` (either one; key *names* are
  recorded, values never are). `SUNDAY_EVAL_MODEL` optionally pins the model;
  `SUNDAY_EVAL_TASK_TIMEOUT_MS` overrides the per-task budget (default 10 min).
- With no keys the script prints `live baseline skipped: no keys` and exits 0
  — safe to run in CI without secrets.
- Drives a real model through `sundayd` over stdio using the current wire
  protocol (`LiveBaselineAdapter` in `packages/eval/src/adapters.ts`):
  `sunday/hello` handshake, `session/create`, `chat/send`, then harvests
  `tool-call` / `tool-result` / `usage` events from the nested `chat/event`
  notifications until `turn-end`. A `tool-result` with `isError: true` marks
  its call invalid; token counts accumulate per task.
- Writes `eval-results/baseline-<timestamp>/{report.json,RESULTS.md}` and
  `docs/eval-baseline-<YYYY-MM-DD>.md`. Exit code is 1 when targets are not met.

### Pass targets (1.0-beta)

| Metric | Target | Rationale |
|---|---|---|
| Task pass rate | ≥ 80% | Fake-scripted ceiling is 100% (14/14); live models are stochastic, so the bar allows a few model-variance failures while catching systematic regressions. |
| Mean tool reliability | ≥ 95% | Tool calls are schema-validated server-side; the overwhelming majority should be valid. |
| Max task duration | ≤ 10 min (harness timeout) | Hung turns are failures, not slow passes. |

Latency (p50/p95) and total token usage are recorded per baseline for trend
tracking but are **not** gating — provider latency varies too much to gate a
release on it.

## Current baseline (hardening phase, fake-scripted)

14/14 tasks passed · mean tool reliability 100.0%.

Live-model baselines are recorded per release in the release notes.
