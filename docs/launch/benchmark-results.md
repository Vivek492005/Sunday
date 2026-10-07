# Sunday eval benchmark — orchestration vs single-agent

Date: 2026-10-07 · Adapter: `fake-scripted` (no API keys; scripted steps replayed through the real tool registry) · Harness: `packages/eval` (`sunday-eval run`)

## Methodology

- **14 tasks**, each with fixture setup + scripted model transcript + a checker that inspects real workspace state. Run in isolated temp workspaces via `runBenchmark` (writes `report.json` + `RESULTS.md`).
- **Orchestration mode** = the harness as shipped: the 3 parallel tasks exercise real orchestration machinery — `validatePlanUnits` (planner), the real `MultiAgentScheduler` from `@sunday/gateway`, and owns_paths disjointness checks.
- **Single-agent mode** = a throwaway baseline script (deleted after the run) replaying the same 3 parallel task scripts **serially through the real tool registry with zero orchestration machinery**: no plan validation, no units, no scheduler contention. Same tools, same checkers' semantics.
- Wall-clock speedup is **not** measurable here: fake-scripted adapters replay steps sequentially in both modes (the tasks' own comments note that concurrent unit execution requires live adapters). The measured deltas are **safety/robustness properties**, not speed.

## Overall results (orchestration mode, fake-scripted)

**14/14 passed · mean tool reliability 100.0% · total 623ms**

| Task | Pass | Tool calls | Notes |
|---|---|---|---|
| read-file | ✅ | 1/1 | file read, content matches |
| list-glob | ✅ | 1/1 | both files listed |
| grep-search | ✅ | 1/1 | marker found in app.ts |
| edit-file | ✅ | 2/2 | port updated, rest intact |
| write-file | ✅ | 1/1 | file created with exact content |
| read-edit-verify | ✅ | 3/3 | bumped and verified absent |
| terminal-run | ✅ | 1/1 | command output captured |
| git-status | ✅ | 1/1 | modified file reported |
| orchestrate-plan | ✅ | — | plan validated by orchestrator planner |
| browser-policy | ✅ | — | file:// + private IPs blocked |
| parallel-disjoint-refactors | ✅ | 2/2 | both disjoint refactors applied, no overlap |
| parallel-overlap-rejected | ✅ | — | rejected at plan time with `plan-overlap`, before any unit ran |
| parallel-quota-fairness | ✅ | — | 3 agents × 4 requests served; max inter-grant gap ≤ 3 (no starvation) |
| browser-seeded-ui-bug | ✅ | 8/8 | snapshot→console→edit→verify_ui→walkthrough in order; typo fixed; walkthrough.md written |

## Orchestration vs single-agent — the 3 parallel tasks

| Task | Orchestration mode | Single-agent mode |
|---|---|---|
| parallel-disjoint-refactors | ✅ PASS — both refactors applied, owns_paths disjointness verified (2 distinct root dirs) | ✅ PASS — serial replay of the same 2 edits also succeeds (7ms), but with **no path-ownership isolation**: a conflicting script would not be caught |
| parallel-overlap-rejected | ✅ PASS — overlapping draft (`src/api/**` vs `src/api/routes/**`) **rejected at plan time** with `plan-overlap`; zero units ran | ❌ FAIL — no planner exists; the overlap is never detected and **unit B silently overwrote unit A's edit** (demonstrated) |
| parallel-quota-fairness | ✅ PASS — 12 grants across 3 contending agents (167ms); every agent served 4×, max gap 3 → **no starvation** | ✅ PASS (trivially) — 1 agent, 4 sequential grants (31ms); zero contention, so the no-starvation bound is never exercised |

**Headline: orchestration 3/3 vs single-agent 2/3 on the parallel tasks.** The single-agent failure is the important one: without plan-time validation, overlapping work is silently clobbered instead of rejected before it starts.

## Caveats

- Fake-scripted only; live adapters (real models via sundayd) were not run — no provider keys available. End-to-end orchestration timing and true parallel speedup need a live run.
- No speedup numbers are claimed from this run (see Methodology). The comparison measures correctness/safety properties under the harness's deterministic scripts.
- Raw artifacts: `report.json` / `RESULTS.md` were written to the run's `--out` dir at benchmark time; this doc is the durable summary.
