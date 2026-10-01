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

## Current baseline (hardening phase, fake-scripted)

14/14 tasks passed · mean tool reliability 100.0%.

Live-model baselines are recorded per release in the release notes.
