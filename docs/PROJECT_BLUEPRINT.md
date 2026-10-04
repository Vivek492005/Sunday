# SUNDAY — Project Blueprint

Complete phase-by-phase blueprint of the Sunday project, from foundation to
the current 1.0-beta push. Generated 2026-10-04.

**Product:** SUNDAY — an AI-native desktop IDE built on a VS Code 1.140.0
fork, with a per-user AI daemon (`sundayd`), a VS Code extension
(`sunday-agent`), CLI, hosted gateway, and (in progress) JetBrains plugin.

**Repo:** `github.com/Vivek492005/Sunday` · **Local:** `~/workspace/sunday-product`
**Branch:** `main` · **Head:** `cc17e3d5` (2026-10-04)

---

## Timeline (visual)

```
Sep 2026 ────────────────────────────────────────────── Oct 2026 ──►

[Foundation]  [v0.1.0]  [Editor Intel]  [Parallel]  [Browser UI]  [Hardening]
 Sep 21-30    Oct 1      Oct 1 eve        Oct 1       Oct 1-2       Oct 1-3
  setup+       shipped    569 tests       668 tests   742 tests     805 tests
  rename       live       MCP+skills      agents      browserd      security
  vendor                    release                     release       release

                                    [Fork Build]  [Phase 8]  [Release Gates]  [1.0-beta prep]
                                     Oct 3         Oct 3-4     Oct 4            Oct 4
                                     branding      7 items     8/11 gates       checklist
                                     CI loop       100%        evidence         + notes

                                                                  [JetBrains]  [Daemon S4]
                                                                   Oct 4        Oct 4
                                                                   built        built→reverted
                                                                   (uncompiled) (post-beta redo)
```

---

## Phase 1 — Foundation (Sep 2026)

| | |
|---|---|
| **Dates** | 2026-09-21 → 2026-09-30 |
| **Objective** | Stand up the project: own repo, own name, vendor the full VS Code source for the fork build. |
| **Status** | ✅ Complete |

### Key deliverables
- Standalone repo `Vivek492005/Sunday` created (not a GitHub fork — full ownership feel)
- **AURORA → SUNDAY rename** across the product (`aurora.*` → `sunday.*`, `~/.aurora` → `~/.sunday`, `aurorad` → `sundayd`); naming map in `docs/NAMING.md`
- VS Code 1.140.0 source vendored under `vscode/` (~310MB, 19,324 files) from the fork's `sunday/main` branch — commit `1772f2e`
- Product workspace scaffold: 13 packages (`protocol`, `gateway`, `sundayd`, `tools`, `context`, `browserd`, `ext-agent`, `ui-chat`, `ui-manager`, `eval`, `orchestrator`, `mcp`, `skills`) — commit `7eb1d758`
- Phase 1a–1f: protocol (versioned JSON-RPC), gateway (OpenRouter + Groq, SSE), tools (filesystem/search/terminal/git), context (repo map, TF-IDF indexer), sundayd (stdio transport, sessions, agent loop), ext-agent (sidecar spawn, HostBridge), ui-chat (React streaming panel)

### Commits
`33e12cef` Initial commit · `7eb1d758` scaffold · `b08e4fcb` protocol · `4a57d2ff` gateway · `f157d6f8` tools · `1772f2ec` vendor VS Code · `f8935515` sundayd · `58c6dfa1` ext-agent · `299f46fd` ui-chat · `90402c72` context · `6b4c072d` router policies · `de41609c` Agent Manager (Phase 4) · `9f3ecf4d` orchestration (Phase 5) · `c5b70d13` browserd (Phase 6) · `552a0553` Phase 7 (eval harness, Windows packaging)

### Test counts
Phases 1–7 cumulative: **285 tests green** (Phase 7 commit message).

---

## Phase 2 — v0.1.0 Extension Release (2026-10-01)

| | |
|---|---|
| **Objective** | Ship the first public, installable artifact: VSIX + Windows installer. |
| **Status** | ✅ Complete — **LIVE** |

### Key deliverables
- `scripts/package-vsix.mjs` — bundles sidecars via esbuild, produces `sunday-agent-0.1.0.vsix`
- NSIS Windows installer (`Sunday-Agent-Setup-0.1.0.exe`)
- `.github/workflows/windows-package.yml` — 9 consecutive CI failures fixed in one session (orchestrator cycle, lockfile, NUL/CRLF, 8.3 paths, esbuild .bin, ESM file:// URL, vsce .cmd, NSIS OutFile)
- Public release: `github.com/Vivek492005/Sunday/releases/tag/v0.1.0` — both assets verified downloadable (VSIX 227,507 B, EXE 274,228 B)

### Commits
`597be6c4` (tag v0.1.0 → force-moved here) · CI fixes `7124aa04`, `f80889c2`, `dbc308e9`, `4cdd2f3e`, `5ee77877`, `41feacdb`

### Verification
- CI run `36861217797` = success; tag run `36867738162` = success
- Release page HTTP 200, both assets present

---

## Phase 3 — Editor Intelligence (2026-10-01 ~21:00 IST)

| | |
|---|---|
| **Objective** | Make the editor smart: MCP tools, skills/rules, autocomplete, mentions. |
| **Status** | ✅ Complete — pushed + remote verified |

### Key deliverables
- `@sunday/mcp`: McpHub (stdio + Streamable HTTP), `mcp__server__tool` namespacing, approvals, tool cap + `tool_search`
- `@sunday/skills`: SkillLoader, RuleLoader, memory with secret refusal, trust gating
- sundayd + ext-agent wiring incl. MCP sidebar panel
- Gateway FIM + sundayd CompletionOrchestrator + ghost-text autocomplete (Tab-to-accept)
- Inline edit (Ctrl+I) with diff review; code actions (Fix/Explain/Tests); commit-message generation; terminal error explain
- Mentions: `@file` `@folder` `@symbol` `@selection` `@terminal` `@diagnostics` `@git-diff` `@web` `@docs`; image paste with downscale

### Commit
`473f7c45`

### Test counts
**569/569 green**, 13 packages.

---

## Phase 4 — Parallel Agents (2026-10-01 ~21:50 IST)

| | |
|---|---|
| **Objective** | Run multiple agents concurrently with safe merging. |
| **Status** | ✅ Complete — pushed + remote verified |

### Key deliverables
- Parallel orchestrator runner: bounded pool (~3), per-unit AbortController, `owns_paths` overlap gate, deferred merge phase with conflict detection, plan-order worktree/merge + checkpoint, single final Verifier, restart-safe state store (`~/.sunday/orchestrations/`)
- sundayd `orchestrate/run|stop|status|merge|resolveConflict` RPCs + `RunNotFound=-32005` + lifecycle reconcile
- Protocol `orchestrate/*` schemas + `queued`/`conflicted` events
- Gateway MultiAgentScheduler: round-robin fair queuing, no-starvation bound, P0>P1>P2, quota wait/resume, ETA estimates
- ext-agent: `sunday.orchestration.parallel` config (default false, ADR-17), run/stopAll/openManager commands, per-unit cards, conflict cards
- ui-manager webview orchestration section; eval +3 parallel benchmark tasks

### Commit
`8fe8ed3a`

### Test counts
**668/668 green**, 13 packages.

### Known gaps (documented)
- `orchestrate/resolveConflict` after daemon restart throws unknown-run
- Notifications are `showInformationMessage` only (no OS path)

---

## Phase 5 — Browser Agent UI (2026-10-01 ~22:24 IST)

| | |
|---|---|
| **Objective** | Give agents a real browser with a live UI panel. |
| **Status** | ✅ Complete — pushed + remote verified |

### Key deliverables
- `browserd`: screencast (start/stop, frame cache), goBack/goForward/reload, session recording (`~/.sunday/browser-sessions/<id>/media`), takeover/release/control (actions throw `BrowserTakeover=-32006` while user controls; fake driver emits real JPEG frames)
- Protocol `browser/screencast/*`, `browser/frame/latest`, `browser/recording/*`, `browser/takeover|release|control`
- sundayd BrowserdManager passthroughs + `SUNDAY_BROWSER_ENABLED` opt-in gate + `browser/panel/*` RPCs + `browser_walkthrough` tool (markdown + `media/step-N.png` under `.sunday/artifacts/<session>/media`)
- ext-agent Agent Browser panel webview (live 2fps, URL bar, Take over/Resume, Screenshot), `sunday.browser.open/takeover` commands, `sunday.browser.enabled` config (default false)
- Eval `browser-seeded-ui-bug` task (14 tasks total) + 21 browser security tests (file:// + private ranges blocked, approval-once-per-origin, eval gating, profile isolation)

### Commit
`ffcbac57`

### Test counts
**742/742 green**, 13 packages.

### Known gaps (documented)
- Panel polls at 2fps (no frame notifications via ChildRpcClient)
- Enabling browser needs sidecar restart
- Real Chromium never ran on this VM (fake-driver-tested)

---

## Phase 6 — Hardening (2026-10-01 → pushed 2026-10-03)

| | |
|---|---|
| **Objective** | Security, sandbox, accessibility, performance, and release-grade docs. |
| **Status** | ✅ Complete — pushed, remote verified |

### Key deliverables
- **Security:** 6 findings fixed (sub-agent policy bypass, MCP trust fail-closed, symlink escape via realpath, untrusted-output delimiters + `INJECTION_GUARD`, secret redaction, session files 0600); `docs/THREAT_MODEL.md` (STRIDE-lite, 12 findings); `SECURITY_AUDIT.md`; `sbom.json` (CycloneDX, 274 components); secret-scan CI job
- **Sandbox:** `sunday.sandbox.mode` (off/docker/bubblewrap), fail-closed; `SANDBOX.md`, `PRIVACY.md`
- **A11y:** 9 fixes; `ACCESSIBILITY.md` 13-step keyboard walkthrough
- **Perf:** cold start 824ms median, idle RSS ~41.5MB flat, autocomplete p50<150ms CI-gated; `PERFORMANCE.md`
- **Docs:** SECURITY.md, PROVIDER_SETUP.md (keys env-var-only; Ollama = roadmap), TROUBLESHOOTING.md, INSTALL.md, UPGRADE.md, RELEASE_GATES.md
- **Legal:** Apache-2.0 chosen, copyright "Sunday" — commit `25ef2350` (LICENSE at root, `"license": "Apache-2.0"` in root + all 13 package.json, `THIRD-PARTY-NOTICES.md`)

### Commits
`234e3204` (hardening) · `25ef2350` (licence)

### Test counts
**805/805 green**, eval 14/14.

---

## Phase 7 — Fork Build (2026-10-03)

| | |
|---|---|
| **Objective** | Brand the VS Code fork as SUNDAY and build the full desktop IDE in CI. |
| **Status** | 🔄 In Progress — branding done; 3-platform CI build never green yet |

### Key deliverables
- SUNDAY branding: `product.json` (P-001), icons (P-002), fresh GUIDs
- `scripts/sync-builtin.sh` — builtin extension staging + `createRequire` esbuild fix
- `.github/workflows/sunday-ide.yml` — full IDE compile on Windows/Linux/macOS (`workflow_dispatch` + `ide-v*` tags)
- 7 CI-fix rounds: secret-scan exit-code judging, `MentionPopup.tsx`/`mentionPopup.ts` case collision, Linux kerberos apt deps, macOS `/tmp` symlink realpath, bubblewrap platform gate, Windows `$OutputEncoding` terminal fix, merge-phase `persist()` best-effort, `GITHUB_TOKEN` for gulp (macOS js-debug 403), `.moduleignore` Copilot SDK re-include

### Commits
`486bf5b6` (fork build) · CI fixes `6f2527de`, `c4fdfd2e`, `a3d6ea9b`, `115d1ad1`, `9c05b003`

### Status detail
Fork-vs-upstream 1.140.0 drift measured 2026-10-04: **zero unregistered drift** (4 diffs: line-ending noise, 2 Sunday metadata files, 1 unvendored build artifact). Current tree: 24 files, all registered patches (P-001, P-002). Budget: 2/25 patches, 1,184/1,500 lines, 23/60 files — all within limits.

---

## Phase 8 — Backlog (7 items, 2026-10-03 → 2026-10-04)

| | |
|---|---|
| **Objective** | Implement the 7 deferred roadmap items end-to-end. |
| **Status** | ✅ Complete — **100%**, all pushed, remote verified at `2ce0abae` |

| # | Item | Commits | Tests |
|---|---|---|---|
| 1 | **P-030 Agent Manager** — Stage 1 editor-area panel; Stage 2 dedicated window (`sunday.manager.open`, `sunday.manager.openWindow`); zero `vscode/` changes | `3f36335b`, `723d76a9` | ext-agent suite |
| 2 | **Per-user daemon** — Stage 1 socket transport; Stage 2 single-flight (lockfile arbitration); Stage 3 multi-workspace trust/secrets/MCP isolation (shared POSIX socket / Windows named pipe, fail-closed trust, per-workspace secret namespaces) | `a4f68c43`, `a3860f43`, `01d19989` | protocol 18/18, sundayd 237/237, ext-agent 249/249, real socket E2E |
| 3 | **Next-edit suggestions** — experimental `sunday.nextEdit.enabled` (default false); rename-propagation CodeLens with stale-version guard | `faad0ca0` | 26/26 new; ext-agent 275/275 |
| 4 | **Cloud/background agents + PR creation** — `background/run\|status\|cancel`; detached execution in shared daemon, isolated worktree/branch, commit → push → PR; never auto-merges | `6b0a55d7` | 13/13 background; orchestrator 72/72 |
| 5 | **Voice input/output** — Web Speech API input + `speechSynthesis` output; `sunday.voice.inputEnabled` / `sunday.voice.outputEnabled` (default false); no audio sent to Sunday servers; `docs/VOICE.md` | `f96c2ef6` | ui-chat 58/58, ext-agent 277/277 |
| 6 | **CLI frontend** — `packages/sunday-cli/`: `sunday chat`, `sunday status`, `sunday sessions`; reuses shared per-user daemon | `4eb87804` | 14/14 + real sundayd E2E |
| 7 | **Hosted gateway** — `packages/hosted-gateway/`: OpenAI-compatible `/v1/chat/completions` + SSE; text chat only (no remote exec); timing-safe Bearer auth, rate limits, model allowlist, IP/CIDR allowlist, JSONL audit logs | `c5c958fd` | 44/44 + CLI smoke |
| — | Phase 8 documentation (`docs/PHASE8.md`, README, ARCHITECTURE) | `2ce0abae` | — |

---

## Phase 9 — Release Gates, 1.0-beta (2026-10-04)

| | |
|---|---|
| **Objective** | Prove release readiness across 11 gates (Appendix A.5). |
| **Status** | 🔄 In Progress — **2/11 Green, 7 Partial with evidence, 2 pending** |

| # | Gate | Status | Evidence (2026-10-04 work) | Flip condition |
|---|---|---|---|---|
| 1 | Build — 3-platform clean build | Partial | Windows x64 green on v0.1.0 tag. Fork CI never green on current tree. | `sunday-ide` CI green |
| 2 | Tests — suites + Electron smoke 3 OSes | Partial | 805/805 unit green (Linux). Smoke harness `scripts/smoke/` (7 checks) + CI step added. | One green `windows-package` run with smoke passing |
| 3 | Eval — live-model baseline + targets | Partial | Fake-scripted 14/14. `live-baseline.ts` + targets (≥80% pass, ≥95% tool reliability, ≤10 min/task). | Run with provider keys, attach report |
| 4 | Relay — §24.3 matrix + chaos | Partial | `relay-matrix.test.ts` 10/10 pass. CI step + report artifact. | One green `windows-package` run |
| 5 | Security — no open High/Critical | Partial | SEC-07 fixed (MCP history redaction). SEC-09/10 deferred, SEC-11 accepted (`SECURITY_DISPOSITIONS.md`). osv-scanner CI job (report-only). | Advisory-scan green → make blocking |
| 6 | Privacy — idle silent, local-only verified | Partial | Idle-silent 2/2. `privacy-pcap.mjs` PASS on VM. `PRIVACY_PCAP.md` manual procedure. | Human 5-min pcap |
| 7 | Performance — startup +10%, 1h soak | Partial | Cold start 824ms. 5m soak PASS (101MB max, 0 leak). Baseline procedure scripted. | Stock baseline + 1h soak on Windows |
| 8 | Accessibility — screen-reader pass | Partial | 9 fixes + Phase 8 re-audit (zero new issues). 30-min checklist `ACCESSIBILITY_TEST_CHECKLIST.md`. | **Human** NVDA/VoiceOver + sign-off |
| 9 | Docs | ✅ Green | All guides present, fact-checked | — |
| 10 | Legal | ✅ Green | Apache-2.0, copyright "Sunday" (`25ef2350`) | — |
| 11 | Upgrade — rehearsal within budget | Partial | Zero unregistered drift. Budget 2/25, 1,184/1,500, 23/60. | Re-vendor timing on next upstream tag |

### Gate commits (2026-10-04)
`ccc15b04` Security · `93d1fc18` Relay · `218174a4` Tests · `c038594d` Performance · `663d77b1` Eval · `3a856777` Privacy · `7a4aa480` Upgrade

### CI-fix rounds (2026-10-04, 6 rounds)
1. `ac990f6d` — `pnpm-lock.yaml` regen (hosted-gateway's 5 missing deps)
2. `4887b5f2` — secret-scan exclusion for `mcp.test.ts` (fake `github_pat_` fixture)
3. `75d3de62` — macOS `realpathSync(tmpdir())`; Windows eval `/tmp` → `os.tmpdir()`; Ubuntu `.moduleignore` Copilot SDK re-include
4. `ce7a1709` — cross-platform `browser-seeded-ui-bug` task (Unix `&`/`$!`/`sleep` → stub)
5. `ff602dc3` + `cc17e3d5` — Windows named-pipe paths for socket tests
6. (pending) latest `windows-package` result

---

## Phase 10 — 1.0-beta Prep (2026-10-04)

| | |
|---|---|
| **Objective** | Have everything ready to cut the beta the moment gates flip. |
| **Status** | ✅ Prep complete — release itself ⏳ pending (CI green + human steps) |

### Key deliverables
- `docs/BETA_RELEASE_CHECKLIST.md` — version plan (`0.1.0` → `1.0.0-beta.1`, 15 packages), verification steps, 8 known limitations, post-release steps — commit `333cb025`
- `docs/RELEASE_NOTES_1.0-BETA.md` — draft notes (all Phase 8 features, gate work, upgrade instructions, no breaking changes)
- `docs/FINAL_REVIEW_2026-10-04.md` — full-session review document — commit `0fbacbbf`
- Stale Legal gate text fixed in `docs/RELEASE_GATES.md` (1/11 → 2/11)

### Remaining for 1.0-beta (ordered)
1. CI green (`windows-package` + `sunday-ide`)
2. Advisory-scan → blocking
3. Human: Accessibility checklist (30 min)
4. Human: Privacy pcap (5 min)
5. Human: Performance baseline + 1h soak
6. Human: Eval live baseline (provider keys)
7. Human: A.6 QA ritual (never recorded end-to-end)
8. Version bump → tag `v1.0.0-beta.1` / `ide-v1.0.0-beta.1` → GitHub release

---

## Phase 11 — Post-beta / Future

| | |
|---|---|
| **Objective** | What's next after 1.0-beta ships. |
| **Status** | ⏳ Pending (one item built early, then parked) |

### Items
1. **JetBrains plugin** — 🔄 built 2026-10-04, uncompiled. Kotlin IntelliJ Platform plugin (`packages/jetbrains-plugin/`): chat tool window (streaming, tool-call indicators), 3 actions (Open chat `Ctrl+Alt+S`, Send selection, Explain code), sundayd socket-protocol client (no new protocol). 19 JUnit tests written. Commits `9e94befd` + `f307a1a2` (pnpm workspace package.json). Needs JDK 17 + Gradle to compile; then bundle sundayd, publish to Marketplace.
2. **Daemon Stage 4** — 🔄 built then **reverted** 2026-10-04. Idle shutdown (30-min default), autostart generators (systemd/launchd/Windows Task XML) + CLI flags, workspace-aware notification routing. Tests were green locally (sundayd 261/261, ext-agent 286/286) but Windows CI daemon-connector tests failed ("sundayd exited during startup"); root cause unisolated → reverted via `ace8ccb5` to unblock CI. Re-implement post-beta, Windows-first.
3. **1.0 final** — ⏳ scope after beta feedback. Candidates: installer code signing (`TODO(signing)`), advisory-scan blocking flip, A.6 findings.
4. **Deferred security** — SEC-09 (taint escalation), SEC-10 (credential ask-gating) — `docs/SECURITY_DISPOSITIONS.md`.
5. **Ollama support** — roadmap-only; unlocks D2 localhost-model privacy verification.
6. **Next-edit LLM re-ranker** — current is heuristic rename propagation.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        SUNDAY IDE (fork)                        │
│  VS Code 1.140.0 + P-001 product.json + P-002 icons/resources   │
│  Built-in: sunday-agent extension (via scripts/sync-builtin.sh)  │
└────────────────────────────┬────────────────────────────────────┘
                             │ JSON-RPC (stdio)
┌────────────────────────────▼────────────────────────────────────┐
│                    sunday-agent (ext-agent)                       │
│  sidecar spawn · HostBridge · chat view · manager view ·         │
│  browser panel · MCP panel · notifications · smoke API           │
└──────┬──────────────┬───────────────┬────────────────────────────┘
       │ socket       │ socket        │ socket
┌──────▼──────────────▼───────────────▼────────────────────────────┐
│                    sundayd (per-user daemon)                     │
│  single-flight · sessions · agent loop · policy gate ·           │
│  orchestrator · browserd mgr · MCP hub · skills · sandbox        │
└──────┬──────────────────────────────────────────────────────────┘
       │ HTTPS (BYOK — user keys, never embedded)
┌──────▼──────────────────────────────────────────────────────────┐
│              gateway → OpenRouter / Groq (failover)              │
│  MultiAgentScheduler (fair queue) · visible Relay fallback      │
└─────────────────────────────────────────────────────────────────┘

Frontends:  VS Code ext │ CLI (sunday chat) │ hosted-gateway (OpenAI-compat)
            JetBrains plugin (Kotlin, uncompiled)
Packages:   protocol · tools · context · mcp · skills · orchestrator
            browserd · ui-chat · ui-manager · eval · sunday-cli
```

**Data flow (privacy):** only user-initiated provider calls leave the machine.
Idle daemon = zero outbound traffic (verified). Secrets redacted before
storage and before provider calls. Session files 0600.

---

## Test Summary

| Package | Tests | Notes |
|---|---|---|
| protocol | 18/18 | socket paths, handshake |
| tools | 34/34 | — |
| skills | 58/58 | incl. secret redaction |
| context | 30/30 | repo map, indexer |
| gateway | 49/49 | 39 existing + 10 relay-matrix |
| mcp | 26/26 | incl. SEC-07 redaction test |
| browserd | 57/57 | incl. 21 browser-security |
| orchestrator | 72/72 | — |
| sundayd | 237/237 | sessions, trust, sandbox, privacy |
| ext-agent | 277/277 | panels, smoke API, notifications |
| eval | 14/14 | 9 harness + 5 live-baseline |
| ui-chat | 58/58 | incl. 8 a11y |
| ui-manager | 25/25 | incl. 5 a11y |
| sunday-cli | 14/14 | — |
| hosted-gateway | 44/44 | abuse controls |
| **Total** | **~1,013** | all green on Linux VM |

Phase progression: 285 (Ph7) → 569 (Editor Intel) → 668 (Parallel) → 742 (Browser UI) → 805 (Hardening) → ~1,013 (now).

---

## Key Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Providers | OpenRouter + Groq | Free-tier, open models; user: "as you wish" |
| Runtime | API-first | User explicitly does NOT want model load on their PC |
| Local models | Ollama = optional/roadmap | Not the default |
| Target OS | Windows (for now) | sundayd PowerShell-aware; packaging via GH Actions Windows runners |
| Build machine | GitHub Actions (16GB) | This VM is 7.7GB/2vCPU — full VS Code build needs ~16GB |
| Build discipline | Sequential (`--workspace-concurrency=1`) | Parallel `pnpm -r` OOM-kills tsc here |
| Product name | SUNDAY (never AURORA) | User retired AURORA 2026-10-01 |
| Licence | Apache-2.0, copyright "Sunday" | User chose 2026-10-03 |
| Repo | Standalone `Vivek492005/Sunday` | Not a GitHub fork — ownership feel |
| Demo policy | 100% build first, demo after | User's standing instruction — never ask for demo checkpoints |
| Credentials | One-time PAT via env, never stored | Refused 2026-10-03 request to save PAT in memory |

---

## Appendix: full commit list (newest first)

```
0fbacbbf Final review document for 2026-10-04 session
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
2ce0abae Docs: Phase 8 features documentation
29cb4f15 Fix CI: sync pnpm-lock.yaml for protocol @types/node
092251a8 Fix CI build: add @types/node to protocol package
b3f245bc Update progress: Phase 8 complete (100%)
c5c958fd Phase 8: hosted gateway with abuse controls (experimental)
69e2a223 Update progress: Phase 8 at 80%
4eb87804 Phase 8: CLI frontend for sundayd (experimental)
94680afb Update progress: Phase 8 at 70%
f96c2ef6 Phase 8: voice input/output (experimental)
9a98e589 Update progress: Phase 8 at 60%
6b0a55d7 Phase 8: cloud/background agents with PR creation (experimental)
faad0ca0 Phase 8: next-edit suggestions (experimental)
01d19989 Phase 8 per-user daemon Stage 3: multi-workspace correctness
9c05b003 Round-7 CI fixes (from authenticated logs)
a3860f43 Phase 8 per-user daemon Stage 2: single-flight
6798691e Add progress tracking system + artifact verification script
a4f68c43 Phase 8 per-user daemon Stage 1: socket transport
723d76a9 Phase 8 P-030 Stage 2: Agent Manager dedicated window
3f36335b Phase 8 P-030 Stage 1: Agent Manager as editor-area WebviewPanel
115d1ad1 Windows CI: relax timing-sensitive parallel test assertions
64884779 Test robustness: small featureDelayMs in timing-sensitive parallel tests
d4d134a1 CI round-4 fixes: Windows parallel-test path canonicalization; copilot .claude EEXIST
8ff0ce7f Fix sunday-ide CI round 3 failures (run 37132746321)
a3d6ea9b Fix sunday-ide CI test failures (run 37131712122)
c4fdfd2e Fix sunday-ide CI failures (run 37131065826)
6f2527de Fix secret-scan CI: git grep exit 1 (no matches) is the clean case
486bf5b6 Full fork build: SUNDAY branding + builtin integration + sunday-ide CI workflow
25ef2350 Legal: Apache-2.0 license for SUNDAY product code
234e3204 Hardening phase: security fixes, sandbox, privacy, a11y, perf, release docs
ffcbac57 Browser Agent UI phase: Agent Browser panel, screencast, takeover, verify_ui, walkthroughs
8fe8ed3a Parallel Agents phase: concurrent orchestration with worktrees, merge flow, fair scheduling
473f7c45 Editor Intelligence phase: MCP client, skills/rules, autocomplete, inline edit, code actions, mentions
597be6c4 Fix Windows CI: absolute OUTFILE for NSIS so the exe lands in the workspace root
41feacdb Fix Windows CI: pass absolute VSIX path to makensis
5ee77877 Fix Windows CI: install NSIS via choco and invoke makensis by absolute path
4cdd2f3e Fix Windows CI: resolve relative --out to absolute in package-vsix.mjs
dbc308e9 Fix Windows CI: run vsce under shell so the .cmd shim resolves via PATHEXT
f80889c2 Fix Windows CI: import esbuild via file:// URL in package-vsix.mjs
7124aa04 Fix Windows CI: bundle sidecars via esbuild JS API (not .bin shell script)
dfacadc1 Fix Windows CI: canonicalize worktree paths via realpath
2a6503f7 Fix Windows CI: normalize git worktree paths
6b47f0d4 Fix Windows CI: git NUL device + CRLF in tests
ba42cdaa Fix lockfile: drop @sunday/sundayd from orchestrator importer (frozen-lockfile was out of sync)
7bcea01e Fix windows-package: break sundayd<->orchestrator package cycle
552a0553 Phase 7: eval harness, Windows packaging, docs, 0.1 release
c5b70d13 Phase 6: browserd — managed browser child + browser_* agent tools
9f3ecf4d Phase 5: hierarchical orchestration (Orchestrator -> Feature Agents -> Verifier)
de41609c Phase 4: Agent Manager — checkpoints, worktrees, manager UI
6b4c072d Phase 3: router policies, rate-limit scheduler, visible Relay fallback
90402c72 Phase 2: @sunday/context — repo map, code indexer, TF-IDF retrieval over JSON-RPC
299f46fd Phase 1f: ui-chat webview — React chat panel with streaming, tool rendering, visible Relay badge
58c6dfa1 Phase 1e: sunday-agent extension — sidecar spawn, HostBridge, commands
f8935515 Phase 1d: sundayd — stdio transport, sessions, agent loop, policy gate
1772f2ec vendor: VS Code 1.140.0 source tree under vscode/ (from Sunday_VS_CODE fork)
f157d6f8 feat(tools): filesystem, search, terminal proxy, read-only git tools (Phase 1c)
4a57d2ff feat(gateway): OpenRouter + Groq adapters, SSE streaming, registry, router (Phase 1b)
b08e4fcb feat(protocol): versioned JSON-RPC surface for sundayd <-> sunday-agent (Phase 1a)
7eb1d758 chore: add Sunday product workspace scaffold (protocol, gateway, sundayd, tools, context, browserd, ext-agent, ui-chat, ui-manager, eval)
33e12cef Initial commit
```
