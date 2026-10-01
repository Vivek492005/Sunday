# Changelog

All notable changes to Sunday. Versions follow semver.

## 0.1.0 — 2026-10-01

First public dev preview.

**Agent core**
- `sundayd` sidecar: NDJSON/stdio JSON-RPC daemon (sessions, agent loop, policy gate, checkpoints, artifacts)
- Tool surface: `read_file`, `write_file`, `edit_file`, `list_dir`, `search`, `run_terminal`, `git_status`, `git_diff`, `git_log` (workspace-confined, JSON-Schema validated)
- `sunday-agent` VS Code extension: sidecar lifecycle, chat + manager webviews, 5 commands, status bar

**Providers & reliability**
- OpenRouter + Groq adapters, router with registry-order failover
- Visible Relay fallback on 429/quota with auto-resume
- Rate-limit scheduler with priorities and fairness

**Multi-agent**
- Agent Manager: shadow-git checkpoints (hunk-level undo), git worktrees, manager UI
- Hierarchical orchestration: Orchestrator → Feature Agents → Verifier (max 8 units, overlap-checked plans, budget enforcement, 2 retries)

**Browser**
- `browserd` child process (FakeDriver for tests, lazy Playwright driver)
- 13 opt-in `browser_*` tools behind the policy gate; localhost allowed, `file://` and private IPs blocked, new origins need approval

**Context**
- Repo map, chunker, TF-IDF retrieval, `context/*` JSON-RPC methods

**Eval & packaging**
- `@sunday/eval`: 10-task benchmark harness (`sunday-eval run`), JSON + Markdown reports; live-model mode via `SUNDAY_EVAL_LIVE=1`
- Windows packaging: `scripts/package-vsix.mjs` → `sunday-agent-0.1.0.vsix` (extension + webviews + bundled sundayd/browserd), NSIS installer, GitHub Actions `windows-package` workflow
