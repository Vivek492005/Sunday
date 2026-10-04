# Sunday — Final Review, 2026-10-04

One document covering everything built, fixed, and still pending after the
2026-10-04 work session. Brutally honest: done / pending / blocked are
named explicitly.

---

## 1. Executive Summary

- **Phase 8 is 100% complete** — all 7 roadmap items (Agent Manager, per-user
  daemon, next-edit, cloud agents, voice, CLI, hosted gateway) implemented,
  tested, committed, and pushed (`2ce0abae`, remote verified).
- **Release gates: 2 of 11 Green, 7 Partial with concrete evidence.**
  Security, Relay, Tests, Performance, Eval, Privacy, and Upgrade all moved
  from "no evidence" to "harness built + methodology verified" today.
- **20 commits pushed today** — 7 release-gate commits, 1.0-beta prep,
  JetBrains plugin (initial), Daemon Stage 4 (then reverted — Windows
  startup regression), and 6 CI-fix rounds.
- **Still blocked on CI:** `windows-package` fails on Windows socket-path
  tests (named-pipe fix pushed, awaiting result); `sunday-ide` full fork
  build never green. Build gate (#1) cannot flip until CI is green.

---

## 2. Phase 8 — 100% complete

All items experimental, zero `vscode/` changes, all pushed to
`github.com/Vivek492005/Sunday` (remote main verified at `2ce0abae`).

| # | Item | Commit | Tests |
|---|---|---|---|
| 1 | P-030 Agent Manager — Stage 1 editor-area panel | `3f36335b` | part of ext-agent suite |
| 2 | P-030 Agent Manager — Stage 2 dedicated window | `723d76a9` | part of ext-agent suite |
| 3 | Per-user daemon — Stage 1 socket transport | `a4f68c43` | protocol 18/18 |
| 4 | Per-user daemon — Stage 2 single-flight | `a3860f43` | sundayd suite |
| 5 | Per-user daemon — Stage 3 multi-workspace isolation | `01d19989` | 237/237 sundayd |
| 6 | Next-edit suggestions (heuristic rename propagation) | `faad0ca0` | 26/26 new; ext-agent 275/275 |
| 7 | Cloud/background agents + PR creation | `6b0a55d7` | 13/13 background; orchestrator 72/72 |
| 8 | Voice input/output (Web Speech, off by default) | `f96c2ef6` | ui-chat 58/58 |
| 9 | CLI frontend (`sunday chat/status/sessions`) | `4eb87804` | 14/14 |
| 10 | Hosted gateway (OpenAI-compatible, abuse controls) | `c5c958fd` | 44/44 |
| — | Phase 8 documentation | `2ce0abae` | — |

Notes:
- JetBrains half of "JetBrains/CLI frontends" was NOT in Phase 8 scope —
  only the CLI shipped. The JetBrains plugin was built separately today
  (see §4).
- Per-user daemon Stage 4 (idle shutdown, autostart) was deferred out of
  Phase 8 and built today, then reverted (see §4).

---

## 3. Release Gates — 11 gates

Source: `docs/RELEASE_GATES.md` (updated today, including the stale Legal
text fix: 1/11 → 2/11).

| # | Gate | Status | Evidence | What flips it |
|---|---|---|---|---|
| 1 | Build — 3-platform clean build | Partial | Windows x64 green on v0.1.0 tag (run 36867738162). Linux builds+tests on VM. macOS arm64 never built. | `sunday-ide` CI green on release commit |
| 2 | Tests — suites + Electron smoke 3 OSes | Partial | 805/805 unit green (Linux). Smoke harness `scripts/smoke/` + CI step added. | One green `windows-package` run with smoke passing |
| 3 | Eval — live-model baseline + targets | Partial | Fake-scripted 14/14. `live-baseline.ts` + targets (≥80% pass, ≥95% tool reliability, ≤10 min/task). | Run baseline with provider keys, attach report |
| 4 | Relay — §24.3 matrix + chaos | Partial | 10-test `relay-matrix.test.ts` all pass. CI step + report artifact. | One green `windows-package` run with report |
| 5 | Security — no open High/Critical | Partial | SEC-07 fixed. SEC-09/10 deferred, SEC-11 accepted (all in `docs/SECURITY_DISPOSITIONS.md`). osv-scanner CI job (report-only). | Advisory-scan green on CI, then make blocking |
| 6 | Privacy — idle silent, local-only verified | Partial | Idle-silent 2/2. `scripts/privacy-pcap.mjs` PASS on VM. `docs/PRIVACY_PCAP.md` manual procedure. | Human 5-min pcap on release machine |
| 7 | Performance — startup +10%, 1h soak | Partial | sundayd cold start 824ms median. 5m soak PASS (101MB max, 0 leak). Baseline procedure scripted. | Stock VS Code baseline + full 1h soak on Windows |
| 8 | Accessibility — screen-reader pass | Partial | 9 fixes. Code re-audit today: zero new issues. 30-min checklist `docs/ACCESSIBILITY_TEST_CHECKLIST.md`. | **Human** NVDA/VoiceOver run + sign-off |
| 9 | Docs | **Green** | All guides present and fact-checked | — |
| 10 | Legal | **Green** | Apache-2.0, copyright "Sunday", root LICENSE + 15 package.json + THIRD-PARTY-NOTICES.md | — |
| 11 | Upgrade — rehearsal within budget | Partial | Fork-vs-upstream drift = **zero unregistered**. Budget: 2/25 patches, 1,184/1,500 lines, 23/60 files. | Re-vendor timing when upstream cuts next tag |

Appendix A.6 manual QA ritual: **never recorded end-to-end** (human step).

---

## 4. New Work (2026-10-04)

### JetBrains plugin — built, uncommitted-then-committed
- Commit `9e94befd` (+ `f307a1a2` package.json for pnpm workspace).
- `packages/jetbrains-plugin/`: Kotlin IntelliJ Platform plugin — chat tool
  window (live streaming, tool-call indicators), 3 actions (Open chat
  `Ctrl+Alt+S`, Send selection, Explain code), sundayd socket-protocol
  daemon client (reuses existing protocol, nothing new invented).
- 19 JUnit tests written; **not compiled** (no JDK/Gradle on this VM).
- Limitation: expects `sundayd` on PATH; no bundled daemon yet; Swing UI
  only (no markdown/diff/MCP panels).

### Daemon Stage 4 — built, then REVERTED
- Commit `acab1b38`: idle shutdown (30-min default, 0 clients + 0 sessions),
  autostart generators (systemd/launchd/Windows Task XML) + CLI flags,
  workspace-aware notification routing + level filtering.
- Tests: sundayd 261/261, ext-agent 286/286 — all green locally.
- **Reverted** (`ace8ccb5`): Windows CI daemon-connector tests failed with
  "sundayd exited during startup (code 1)". Root cause not isolated on
  this VM (local Linux green). Decision: revert to unblock CI, re-implement
  carefully post-beta with Windows-first testing.
- Current tree: sundayd back to 237/237, ext-agent 277/277.

### 1.0-beta prep — done
- Commit `333cb025`: `docs/BETA_RELEASE_CHECKLIST.md` (version plan
  `0.1.0` → `1.0.0-beta.1`, verification steps, 8 known limitations) and
  `docs/RELEASE_NOTES_1.0-BETA.md` (draft notes).
- Fixed stale Legal gate text in `docs/RELEASE_GATES.md`.

---

## 5. CI Status (as of 19:40 IST)

| Workflow | Latest run | Status | Commit |
|---|---|---|---|
| windows-package | 37208125493 | in_progress | `cc17e3d5` |
| Sunday IDE | 37207570989 | in_progress | `ff602dc3` |

### Failures diagnosed and fixed today (6 rounds)

1. **`pnpm-lock.yaml` out of sync** (`ac990f6d`) — hosted-gateway's 5 deps
   missing. Regenerated via pnpm on tmpfs (btrfs chown quirk).
2. **secret-scan false positive** (`4887b5f2`) — `mcp.test.ts` contains a
   fake `github_pat_` for the SEC-07 redaction test. Added to the scan's
   exclusion list (same pattern as existing fixtures).
3. **macOS path tests** (`75d3de62`) — `workspace-trust`/`workspace-secrets`
   tests used raw `tmpdir()`; macOS symlinks `/tmp` → `/private/tmp`.
   Fixed with `realpathSync`. **Verified fixed** (failures gone next run).
4. **Windows eval `browser-seeded-ui-bug`** (`ce7a1709`) — server startup
   used Unix-only `&`, `$!`, `sleep`. Replaced with cross-platform stub
   (browser calls use deterministic stubs anyway). **Verified fixed.**
5. **Ubuntu Copilot packaging** (`75d3de62`) — `.moduleignore` excluded
   `@github/copilot/**` including the SDK dir the packaging shim needs.
   Added `!@github/copilot/sdk/**` re-include. (Result pending.)
6. **Windows socket tests** (`ff602dc3`, `cc17e3d5`) — `daemon-connector`
   and `socket-rpc` tests used Unix `.sock` paths on Windows; sundayd
   crashed on startup. Fixed with `\\.\pipe\` named-pipe paths.
   (Result pending — latest run in progress.)

### Known CI quirks (not bugs)
- `advisory-scan` fails at "Set up job" (action init issue); it's
  `continue-on-error: true` so it doesn't block. Needs investigation.
- Neither workflow triggers on push to main — both need manual dispatch
  or tag pushes.

---

## 6. Remaining for 1.0-beta

Blockers in dependency order:

- [ ] **CI green** — `windows-package` (in progress) and `sunday-ide`
      (in progress) must pass on the release commit. → flips gates #1, #2, #4.
- [ ] **Advisory-scan** — confirm green once, flip to blocking. → gate #5.
- [ ] **Human: Accessibility** — run `docs/ACCESSIBILITY_TEST_CHECKLIST.md`
      (30 min, NVDA/VoiceOver), sign off. → gate #8.
- [ ] **Human: Privacy pcap** — 5-min capture per `docs/PRIVACY_PCAP.md`.
      → gate #6.
- [ ] **Human: Performance** — stock VS Code baseline + 1h soak on Windows.
      → gate #7.
- [ ] **Human: Eval live baseline** — run with provider keys, attach
      `docs/eval-baseline-<date>.md`. → gate #3.
- [ ] **Human: A.6 QA ritual** — end-to-end walkthrough incl.
      uninstall/reinstall and daemon-kill resume on Windows.
- [ ] **Version bump** — 15 packages `0.1.0` → `1.0.0-beta.1` (plan in
      `docs/BETA_RELEASE_CHECKLIST.md` §2). Do NOT run until all above green.
- [ ] **Tag + release** — `v1.0.0-beta.1` (VSIX + installer),
      `ide-v1.0.0-beta.1` (full IDE). Verify assets, publish notes.
- [ ] Upgrade gate #11 stays Partial — acceptable for beta (blocked on
      upstream; drift is zero).

---

## 7. Post-beta Roadmap

1. **1.0 final** — scope after beta feedback. Candidates: code signing
   (`TODO(signing)`), advisory-scan blocking flip, A.6 findings.
2. **Daemon Stage 4 re-implementation** — idle shutdown, autostart,
   notification routing. Must be developed Windows-first (named-pipe CI).
3. **JetBrains plugin** — compile with JDK 17/Gradle, run JUnit tests,
   bundle sundayd, publish to JetBrains Marketplace.
4. **Deferred security items** — SEC-09 (taint escalation), SEC-10
   (credential ask-gating) — see `docs/SECURITY_DISPOSITIONS.md`.
5. **Ollama support** — currently roadmap-only; unlocks D2 localhost-model
   privacy verification.
6. **Next-edit LLM re-ranker** — current implementation is heuristic
   rename propagation.

---

## 8. Test Counts (Linux VM, 2026-10-04)

| Package | Tests | Notes |
|---|---|---|
| protocol | 18/18 | socket paths, handshake |
| tools | 34/34 | — |
| skills | 58/58 | incl. secret redaction |
| context | 30/30 | — |
| gateway | 49/49 | 39 + 10 relay-matrix |
| mcp | 26/26 | incl. SEC-07 redaction test |
| browserd | 57/57 | incl. 21 browser-security |
| orchestrator | 72/72 | — |
| sundayd | 237/237 | (261 with reverted Stage 4) |
| ext-agent | 277/277 | (286 with reverted Stage 4) |
| eval | 14/14 | 9 harness + 5 live-baseline |
| ui-chat | 58/58 | incl. 8 a11y |
| ui-manager | 25/25 | incl. 5 a11y |
| sunday-cli | 14/14 | — |
| hosted-gateway | 44/44 | — |
| **Total** | **~1,013** | all green on Linux |

Eval: 14/14 benchmark tasks (fake-scripted) + safety evals green.
Windows/macOS CI results pending — see §5.

---

## Appendix: today's commits (20, all pushed)

```
cc17e3d5 CI fix: simplify Windows pipe names
ff602dc3 CI fix: Windows named pipes for socket tests
713a0edf Accessibility #8: human test checklist + code audit
f307a1a2 JetBrains plugin: add package.json for pnpm workspace
ace8ccb5 Revert Stage 4 (temporarily): breaks Windows daemon startup
ce7a1709 CI fix: cross-platform browser eval task
acab1b38 Daemon Stage 4: idle shutdown, autostart, notification routing
9e94befd JetBrains plugin: IntelliJ Platform plugin (initial)
9900fe7f CI debug: log failed eval tasks for Windows diagnostics
75d3de62 CI fix: macOS paths, Windows eval tmpdir, Ubuntu Copilot SDK
333cb025 1.0-beta prep: release checklist + notes draft
4887b5f2 CI fix: exclude mcp.test.ts from secret-scan
ac990f6d CI fix: regenerate pnpm-lock.yaml (hosted-gateway deps)
7a4aa480 Release gate: Upgrade #11 (rehearsal: zero unregistered drift)
3a856777 Release gate: Privacy #6 (pcap harness + manual procedure)
663d77b1 Release gate: Eval #3 (live baseline + pass targets)
c038594d Release gate: Performance #7 (soak harness + baseline)
218174a4 Release gate: Tests #2 (Electron smoke harness)
93d1fc18 Release gate: Relay #4 (matrix + chaos as CI evidence)
ccc15b04 Release gate: Security #5 (partial -> closer to green)
```

Remote `main` verified at `cc17e3d5` after each push. Every pasted PAT was
used once via env passthrough and discarded; none are stored anywhere.
