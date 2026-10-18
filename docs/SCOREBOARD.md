# Sunday Eval Scoreboard

> Generated 2026-10-18T16:13:30.052Z · task pack v2 · 62 task-runs pooled

Public, reproducible model benchmark for Sunday agents: every model runs
the same versioned task pack with fixed seeds and hidden checkers.
Cost-per-successful-task counts **only verifier-passing tasks** (F1);
loop-trigger rate replays each transcript through the F2 LoopGuard.

## Summary

| Model | Runs | Pass rate | Tool reliability | Median time | Cost / success | Loop-trigger rate |
|---|---|---|---|---|---|---|
| fake-scripted | 2 | 100.0% (range 100.0%–100.0%) | 100.0% | 4ms | 1.5 req | 0.0% |

## Per-category pass rates

| Model | browser | bugfix | edit | feature | git | infra | io | multi-file | plan | refactor | search | security | terminal | tests |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fake-scripted | 100.0% (2/2) | 100.0% (10/10) | 100.0% (4/4) | 100.0% (10/10) | 100.0% (2/2) | 100.0% (2/2) | 100.0% (6/6) | 100.0% (4/4) | 100.0% (4/4) | 100.0% (6/6) | 100.0% (2/2) | 100.0% (4/4) | 100.0% (2/2) | 100.0% (4/4) |

## Methodology

- **Task pack**: versioned (`TASK_PACK_VERSION`), fixed seeds, deterministic fixtures;
  checkers run in-process and are never visible to the model under test.
- **Pass** = the hidden checker accepted the resulting workspace state.
- **Tool reliability** = fraction of tool calls that were schema-valid and error-free.
- **Cost / success** = mean cost over verifier-passing tasks only (F1 metric).
  USD via per-model token pricing when tokens are reported; otherwise gateway requests.
- **Loop-trigger rate** = fraction of tasks where the F2 LoopGuard tripped ≥1 time
  when replaying the transcript (same tool+args repeats, failure repeats,
  apply/revert ping-pong, spend-without-progress).
- **Reproduce**: `sunday-eval run [--live] --out eval-results/<ts>` then
  `sunday-eval scoreboard --runs eval-results --out docs/SCOREBOARD.md`.

_Scores are pooled across repetitions; the pass-rate range shows run-to-run variance._
