# Sunday 1.0-beta — Release Notes (DRAFT)

> **Status:** Draft. Do not publish until the release checklist
> (`docs/BETA_RELEASE_CHECKLIST.md`) is fully green.

## What's new

### Phase 8 — the headline features

**Agent Manager (P-030)** — a dedicated mission-control surface for
parallel agents. Stage 1 lives in the editor area; Stage 2 is a full
dedicated window (`sunday.manager.open`, `sunday.manager.openWindow`).
Per-unit cards, conflict cards, stop-all. Zero changes to VS Code core.

**Per-user daemon (`sundayd`)** — one daemon per OS user, shared across
windows via a POSIX socket / Windows named pipe. Single-flight
arbitration with a lockfile, fail-closed workspace trust, and
per-workspace secret namespaces so two projects never share keys.

**Next-edit suggestions** — experimental rename-propagation CodeLens
(`sunday.nextEdit.enabled`, default off) with a stale-version guard.
Heuristic today; an LLM re-ranker is on the roadmap.

**Cloud / background agents** — `background/run|status|cancel`. Agents
run detached in the shared daemon, in an isolated worktree and branch,
then commit → push → open a PR. Never auto-merges; a human always
merges.

**Voice input/output** — Web Speech API dictation and `speechSynthesis`
readback (`sunday.voice.inputEnabled` / `sunday.voice.outputEnabled`,
both default off). No audio is sent to Sunday servers; you review the
transcript before Send. Privacy notes in `docs/VOICE.md`.

**CLI frontend** — `packages/sunday-cli`: `sunday chat "prompt"`,
`sunday status`, `sunday sessions`. Same daemon, no VS Code required.

**Hosted gateway** — `packages/hosted-gateway`: an OpenAI-compatible
`/v1/chat/completions` endpoint (SSE streaming included) in front of
your providers. Text chat only — remote tool/shell/file execution is
not exposed, by design. Abuse controls: timing-safe Bearer auth, rate
limits, request-size limits, model allowlist, IP/CIDR allowlist, JSONL
audit logs.

### Earlier phases (since 0.1.0)

- **Editor Intelligence** — MCP hub (stdio + Streamable HTTP), skills +
  memory with secret refusal, ghost-text autocomplete (Tab to accept),
  inline edit (Ctrl+I) with diff review, Fix/Explain/Tests code actions,
  commit-message generation, terminal error explanations, `@file` /
  `@folder` / `@symbol` / `@selection` / `@terminal` / `@diagnostics` /
  `@git-diff` / `@web` / `@docs` mentions, image paste with downscale.
- **Parallel Agents** — bounded orchestration (Orchestrator → Feature
  Agents → Verifier), overlap-checked plans, budget enforcement,
  checkpoint/restart, conflict-aware merge.
- **Browser Agent UI** — `browserd` sidecar with live 2 fps panel,
  takeover/release control, recording, `browser_walkthrough` tool
  (dangerous, approval-gated).
- **Hardening** — 6 security findings fixed with regression tests,
  STRIDE-lite threat model (12 findings, all dispositioned), sandbox
  modes, 9 a11y fixes, cold start 824 ms / idle RSS ~41.5 MB,
  autocomplete p50 < 150 ms CI-gated, CycloneDX SBOM (274 components).

### Release-gate work in this beta

- OSV advisory scanning in CI (report-only for now).
- Named §24.3 relay matrix + chaos scenarios as a CI job with a report
  artifact.
- Electron smoke harness (7 checks) as a CI step.
- Live-model eval baseline script with quantified pass targets
  (≥ 80% tasks, ≥ 95% tool reliability, ≤ 10 min/task).
- 1-hour memory-soak harness (verified in 5-min mode, 0 leaks).
- Packet-capture privacy verification harness + manual procedure.
- Upgrade rehearsal: fork-vs-upstream divergence measured at
  **zero unregistered drift** (24 files, all registered patches).

## Breaking changes

- **None for 0.1.0 users.** Config keys are additive; the daemon
  protocol is backward-compatible within 1.x. Session files from 0.1.0
  load unchanged.

## Upgrade instructions (from 0.1.0)

1. Download `sunday-agent-1.0.0-beta.1.vsix` from the release page.
2. In VS Code: Extensions → `···` → Install from VSIX → select the file.
3. Reload. The bundled `sundayd` replaces the old sidecar automatically;
   no manual cleanup needed.
4. `~/.sunday/` (sessions, secrets, checkpoints) is preserved.
5. Optional: try the new CLI — `npx sunday chat "hello"`.

Full-IDE users: download the installer for your OS from the
`ide-v1.0.0-beta.1` release instead; it has the extension built in.

## Known limitations

- Installers are **unsigned** — expect SmartScreen/Gatekeeper warnings.
- Advisory scanning is report-only until one green CI run.
- Ollama local models: roadmap, not implemented.
- Next-edit is heuristic rename propagation (experimental, off by
  default).
- Screen-reader pass and packet-capture verification are pending human
  runs — tracked as release gates, not code gaps.

## Checksums

(TBD at release time — paste `sha256sum` output here.)
