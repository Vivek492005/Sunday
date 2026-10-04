# Phase 8 — complete (100%)

Seven features built on top of the 0.1.0 dev preview, all extension/daemon-side
(zero `vscode/` core changes). Most are experimental and gated behind config
flags (default off); the daemon work is the foundation the others reuse.

## 1. Agent Manager part (P-030)

The ui-manager webview now lives in the editor area instead of only the
Explorer sidebar.

- `sunday.manager.open` — opens/reveals the Agent Manager as an editor-area
  `WebviewPanel` (`ManagerPanelManager`, shared `ManagerWebviewController`
  logic).
- `sunday.manager.openWindow` — moves the panel into a dedicated VS Code
  window (`workbench.action.moveEditorToNewWindow`); the panel object survives
  the move, so state and subscriptions keep working.
- The old Explorer sidebar provider remains registered for backward
  compatibility.
- Code: `packages/ext-agent/src/managerView.ts`. Plan: `docs/PHASE8_PLAN.md`.

## 2. Per-user agent daemon

One `sundayd` per OS user instead of one per VS Code window. Windows attach
to the shared daemon; background agents survive editor close.

- **Stage 1 — socket transport.** Shared NDJSON codec
  (`packages/sundayd/src/rpc-transport.ts`); `sundayd --socket <path>` listens
  on `~/.sunday/sundayd.sock` (POSIX) / `\\.\pipe\sundayd-<user>` (Windows);
  `RpcClient.fromSocket()` in the extension. Stdio path unchanged.
- **Stage 2 — single-flight.** Lockfile mutex (`~/.sunday/sundayd.lock`, `wx`
  exclusive-create + PID): first window spawns the daemon detached, the rest
  attach. Stale locks (dead PID) are stolen. Dispose only detaches — never
  kills a daemon it didn't spawn. Shared path conventions live in
  `packages/protocol/src/daemon-paths.ts`.
- **Stage 3 — multi-workspace correctness.** `daemon/configure`,
  `daemon/set-workspace-trust`, `daemon/status` RPCs. Per-workspace trust map
  (fail-closed: once any workspace is configured, unconfigured paths are
  untrusted), per-workspace MCP hubs and secret namespaces, ancestor-walk
  lookups so session cwds inherit their workspace's verdict. Legacy env-var
  behavior is preserved when no workspace is configured.
- Plan: `docs/PHASE8_DAEMON_PLAN.md`.

## 3. Next-edit suggestions (experimental)

After a rename-like edit, predicts the *next* edit: the following occurrence
of the old identifier, offered as a CodeLens
(`Sunday: rename 'x' → 'y' here`). Accepting it applies the edit via
`WorkspaceEdit` (stale-version guarded) and chains to the next occurrence.
Heuristic-only MVP; isolated from the completion pipeline.

- Config: `sunday.nextEdit.enabled` (default `false`).
- Command: `sunday.nextEdit.apply`.
- Code: `packages/ext-agent/src/nextEdit.ts`.

## 4. Background agents + PR creation (experimental)

Fire-and-forget agent runs that survive editor close, delivered as GitHub PRs.

- `background/run` returns `{ runId }` immediately; the run executes detached
  in the daemon: isolated worktree on `sunday/bg/<id>-<slug>` → agent loop →
  commit → push → `gh pr create` (REST fallback). Progress streams as
  `background/event` (`queued → running → committing → pr-creating →
  pr-created | failed | cancelled`).
- `background/status` (file-backed, survives daemon restart),
  `background/cancel` (aborts, removes the worktree).
- **PRs are never auto-merged** — no merge code path exists; a human merges.
- Same sandbox/trust rules as foreground agents.
- Config: `sunday.backgroundAgents.enabled` (default `false`).
- Code: `packages/orchestrator/src/background.ts`,
  `packages/protocol/src/background.ts`.

## 5. Voice input/output (experimental)

Talk to the agent and hear responses, via the browser Web Speech APIs —
zero dependencies.

- **Input:** mic button in the composer → live interim transcript → final
  transcript appended to the prompt; nothing is sent until the user hits Send.
- **Output:** TTS toggle speaks the cleaned assistant response
  (markdown stripped, truncated); new turns cancel in-progress speech.
- **Privacy:** no audio ever touches Sunday servers. Input uses the browser's
  speech service; output is fully on-device. Only the transcribed text —
  which the user reviews — leaves the webview, exactly as if typed.
- Config: `sunday.voice.inputEnabled`, `sunday.voice.outputEnabled`
  (both default `false`). Graceful degradation when the APIs are unavailable.
- Code: `packages/ui-chat/src/voice.ts`. Privacy notes: `docs/VOICE.md`.

## 6. CLI frontend (experimental)

Terminal access to the same per-user daemon the VS Code extension uses.

- `sunday chat "prompt" [--session <id>] [--model <id>] [--cwd <dir>]` —
  streams `text-delta` to stdout, tool calls + usage to stderr.
- `sunday status [--json]`, `sunday sessions [--json]`.
- Attaches via the shared socket (spawns the daemon detached if needed);
  `--socket` targets a specific daemon.
- Package: `packages/sunday-cli/` (`@sunday/cli`, bin `sunday`).

## 7. Hosted gateway (experimental, optional)

For users **without their own provider keys**. The operator runs this server
with *their* keys; remote clients authenticate with gateway-issued API keys
and get an OpenAI-compatible **text chat** API — nothing else.

- Endpoints: `GET /health` (no auth), `GET /v1/models`,
  `POST /v1/chat/completions` (SSE streaming supported).
- **Text chat only, by construction:** requests containing `tools` /
  `tool_choice` / `functions` are rejected (`400`); model-emitted tool chunks
  are dropped. No shell, no file access, no agent tools.
- **Abuse controls:** Bearer auth (constant-time compare, audit logs use key
  fingerprints), per-key rate limits (requests/min + input tokens/min, `429`
  + `Retry-After`), request size limits, model allowlist, IP/CIDR allowlist
  (`X-Forwarded-For` not trusted), JSONL audit logging (content never logged),
  upstream timeouts.
- Config: `SUNDAY_HOSTED_*` env vars. Full reference:
  `packages/hosted-gateway/README.md`.

## Config flags (all default off unless noted)

| Flag | Default | Feature |
|---|---|---|
| `sunday.nextEdit.enabled` | `false` | Next-edit suggestions |
| `sunday.backgroundAgents.enabled` | `false` | Background agents |
| `sunday.voice.inputEnabled` | `false` | Voice input |
| `sunday.voice.outputEnabled` | `false` | Voice output |

## Test coverage (at time of completion)

| Area | Tests |
|---|---|
| ext-agent (incl. manager, nextEdit, daemon-connector, voice config) | 277 |
| ui-chat (incl. voice) | 58 |
| sundayd (incl. socket transport, workspace trust/secrets/MCP) | 237 |
| protocol | 18 |
| orchestrator (incl. background agents) | 72 |
| sunday-cli | 14 |
| hosted-gateway | 44 |

All suites green; `tsc --noEmit` clean per package.
