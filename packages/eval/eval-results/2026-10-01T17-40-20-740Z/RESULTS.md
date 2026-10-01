# Sunday eval results — fake-scripted

Started: 2026-10-01T17:40:20.740Z · duration 1.4s
**14/14 tasks passed** · mean tool reliability 100.0%

| Task | Pass | Tool calls | Reliability | Time | Notes |
|---|---|---|---|---|---|
| read-file | ✅ | 1/1 | 100% | 13ms | file read, content matches |
| list-glob | ✅ | 1/1 | 100% | 67ms | both files listed |
| grep-search | ✅ | 1/1 | 100% | 6ms | marker found in app.ts |
| edit-file | ✅ | 2/2 | 100% | 2ms | port updated, rest intact |
| write-file | ✅ | 1/1 | 100% | 1ms | file created with exact content |
| read-edit-verify | ✅ | 3/3 | 100% | 2ms | bumped and verified absent |
| terminal-run | ✅ | 1/1 | 100% | 255ms | command output captured |
| git-status | ✅ | 1/1 | 100% | 138ms | modified file reported |
| orchestrate-plan | ✅ | 0/0 | 100% | 0ms | plan validated by orchestrator planner (see unit test) |
| browser-policy | ✅ | 0/0 | 100% | 0ms | policy enforced by browserd policy module (see unit test) |
| parallel-disjoint-refactors | ✅ | 2/2 | 100% | 2ms | both disjoint refactors applied, no overlap |
| parallel-overlap-rejected | ✅ | 0/0 | 100% | 5ms | rejected at plan time with plan-overlap, before any unit ran |
| parallel-quota-fairness | ✅ | 0/0 | 100% | 165ms | 3 agents × 4 requests all served; max inter-grant gap ≤ 3 (no starvation) |
| browser-seeded-ui-bug | ✅ | 8/8 | 100% | 706ms | server served buggy page; snapshot→console→edit→verify_ui→walkthrough in order; typo fixed; walkthrough.md written |
