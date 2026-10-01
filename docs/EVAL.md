# Eval harness (`@sunday/eval`)

Deterministic benchmark for the agent tool surface. Ten tasks — file I/O,
search, edit, multi-step edit+verify, terminal, git, orchestration planning,
browser policy — each with a fixture setup, a scripted model transcript, and
a checker that inspects the resulting workspace.

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

## Current baseline (0.1.0, fake-scripted)

10/10 tasks passed · mean tool reliability 100.0%.

Live-model baselines are recorded per release in the release notes.
