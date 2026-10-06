# Sunday architecture (condensed)

> Full design doc uses the old product name AURORA; the rename mapping is in
> [NAMING.md](NAMING.md). This file describes the system as built.

## Pieces

```
┌─ VS Code ──────────────────────────────┐
│  sunday-agent (built-in extension)      │  TypeScript, esbuild bundle
│   ├─ chat webview      (@sunday/ui-chat)
│   ├─ manager webview   (@sunday/ui-manager)
│   └─ MCP panel webview (self-contained)│
└────────────── stdio JSON-RPC ──────────┘
┌─ sundayd (sidecar) ────────────────────┐  Node, NDJSON/stdio, single file
│  sessions │ agent loop │ policy gate    │  in the packaged build
│  checkpoints (shadow git) │ worktrees   │
│  orchestration host │ context │ artifacts
│  MCP hub │ skills │ memory │ system-prompt injection
└────────────── stdio JSON-RPC ──────────┘
┌─ browserd (child) ─────────────────────┐  spawned lazily by sundayd
│  FakeDriver (tests) / Playwright (lazy) │
└────────────────────────────────────────┘
```

## JSON-RPC surface (`@sunday/protocol`)

Versioned with zod schemas; every method lives in the central `METHODS`
registry, notifications in `NOTIFICATIONS`. Groups:

- `sunday/*` — hello, ping, shutdown
- `session/*` — create, list, restore, close (persisted under `~/.sunday/sessions`)
- `chat/*` — send, cancel; progress streams as `chat/event` notifications
- `tools/*` — list (model-facing definitions)
- `context/*` — repo map, search, chunk retrieval
- `checkpoint/*`, `worktree/*` — Agent Manager
- `orchestrate/*` — plan, run, event (hierarchical multi-agent)
- `browser/*` — child lifecycle (the `browser_*` agent tools are separate,
  opt-in, and dangerous-flagged)
- `mcp/*` — server lifecycle (start/stop/restart), tool list, call history
- `policy/*` — approve/revoke/list per-session approvals for dangerous tools

## Providers (`@sunday/gateway`)

Adapters: OpenRouter, Groq. The router tries the registry order and fails over
on 429/quota; the **Relay** path is visible in the UI (badge + `via: "relay"`
on events) rather than silent. A rate-limit scheduler with priorities and
fairness sits in front of the router. Ollama is an optional local fallback,
not the default — the runtime is API-first.

## Agent loop (`@sunday/sundayd`)

Streaming model → tool calls → policy gate → tool execution → results fed back
as tool messages → repeat until answer or `max-steps`. Malformed args and
policy denials are returned as tool errors so the model can self-correct.
`chat/cancel` aborts via `AbortController`. Sessions persist atomically
(tmp + rename); in-flight persists drain on graceful shutdown.

## MCP + skills + memory (Part A)

MCP lives in `@sunday/mcp` (a `McpHub`: config, lifecycle, tools, bounded
call history), skills/memory/rules in `@sunday/skills`; sundayd wires them
without importing either back into the other packages (no cycles — both
depend only on `@sunday/protocol`).

- **Config scopes.** `~/.sunday/mcp.json` (user) merges over `<ws>/.sunday/mcp.json`
  (workspace). Workspace servers stay visible while the workspace is
  untrusted, but starting one asks the user first (extension-side
  `vscode.window.showWarningMessage`; "Sunday: Trust Workspace" stamps
  `SUNDAY_WORKSPACE_TRUSTED=1` at spawn). Workspace configs may be ignored
  entirely in Restricted Mode (`workspaceConfigIgnored`).
- **Dangerous tools.** Servers declare `dangerous: true` on the tool cap or a
  server opts into `defaultApproval: 'allow'`; everything dangerous flows
  through the PolicyGate as risk class M (Ask), same as `write_file` et al.
  Approvals are per-session, expire on `mcp/server/stop` (stale wrappers are
  re-wrapped without their prior approval), and are manageable from the MCP
  panel (`policy/approve|revoke|list`).
- **Tool search.** Only the first N MCP tools are registered; the rest hide
  behind the read-only `tool_search` agent tool, backed by the hub's fuzzy
  index. Adapters (`adaptMcpTool`) wrap a hub Tool into the registry Tool
  shape.
- **Secrets.** `secret:<key>` refs in `mcp.json` are never resolved inline:
  the extension pre-resolves them from `vscode.SecretStorage` at spawn and
  hands them to sundayd as `SUNDAY_MCP_SECRET_*` env vars (stdio RPC is
  client→daemon only); the daemon's `EnvSecretResolver` reads them back.
  Adding a secret needs a sidecar restart.
- **System prompt.** `session/create` injects a built prompt —
  `## Skills` (names + one-line descriptions, `load_skill` hinted for bodies),
  `## Rules` (system → user → workspace → nested `AGENTS.md`, delimited),
  `## Memory` (`~/.sunday/memory.md` + `<ws>/.sunday/memory.md`) — via the
  pure `buildSystemPrompt`; empty data injects nothing (no behavior change).
- **load_skill trust gate.** Workspace skills that ship scripts refuse to load
  in an untrusted workspace (daemon-side, no user in the loop); the extension
  prompts Allow/Deny for them up front. The `remember` agent tool appends to
  memory files and is dangerous-flagged; secret-looking text is refused.

## Editor intelligence (Part B)

Ghost-text autocomplete, inline edit, code actions, commit-message generation,
terminal-error explain, `@`-mentions, and image paste.

- **Autocomplete (FIM).** The gateway exposes `FimProvider.complete({ model,
  prefix, suffix })`: native `POST /completions` infill when the model entry
  advertises `supportsFim`, otherwise a prefix-only `chat/completions`
  continuation (suffix dropped, temperature 0). Native-endpoint failure falls
  back to chat instead of throwing; `AbortError` always propagates. sundayd's
  `CompletionOrchestrator` adds per-document debounce (default 75 ms), request
  coalescing (a newer keystroke aborts the in-flight one), an LRU cache keyed
  by content hash (invalidated by `docVersion`), a 1-in-flight-per-document
  cap, and sliding-window latency stats behind `completion/stats` plus a
  `sunday.completion.latency` JSON metric line. The extension registers a
  `vscode` inline-completion provider for all languages (`Tab` accepts);
  config `sunday.completion.enabled` (default true), `debounceMs`,
  `model` (default `groq:llama-3.1-8b-instant`).
- **Inline edit (`sunday.inlineEdit`, Ctrl/Cmd+I).** Selection (or whole file)
  + instruction → `chat/send` with a rewrite-only prompt in an edit-scoped
  session → proposed code lands in a temp doc → `vscode.diff` review →
  Accept applies via `editor.edit()`, Reject discards. User-confirmed edit;
  no new RPC was needed.
- **Code actions.** `SundayCodeActionProvider`: "Fix with Sunday" (QuickFix,
  diagnostics-driven), "Explain with Sunday", "Generate tests with Sunday" —
  all via direct `chatSend` + chat-view focus. `sunday.git.commitMessage`
  builds a conventional-commit message from the staged diff (truncated 8k)
  into the SCM input box. `sunday.terminal.explainError` tracks shell-integration
  executions (last-10 failure ring) with an input-box fallback.
- **Mentions + images.** The composer supports `@file @folder @symbol
  @selection @terminal @diagnostics @git-diff @web(url) @docs(name)` with a
  popup (up/down, Tab/Enter, Esc). The extension host expands mentions into
  context blocks (4000 chars/mention cap, overflow handle invites the agent to
  read more via its tools) and pasted images into `image` content parts
  (`{ type: 'image', dataUrl }`, downscaled to 1568 px) — all through the
  existing `chat/send` parts-array shape, serialized as `image_url` blocks by
  the gateway. `@docs` reads `.sunday/skills/<name>/SKILL.md` by convention.

## Orchestration (`@sunday/orchestrator` + sundayd host)

`orchestrate/plan` decomposes a goal into ≤ 8 contracted units (validated
JSON, unique ids, static `owns_paths` overlap rejection, ADR-18 budget).
`orchestrate/run` executes sequentially (v1): one worktree per unit, Feature
Agents get full tool access, a fresh Verifier gets a read-only registry plus
the diff and acceptance criteria. Pass → `--no-ff` merge + checkpoint;
fail → two retries, then continue. The daemon implements
`DaemonOrchestratorHost.runSubAgent` so the orchestrator never imports the
daemon (no import cycle).

Parallel mode (`orchestrate/run` with `parallel: true`, pool default 3):
units run concurrently, each in its own worktree (`sunday/feat/<unit-id>`)
with the same Feature-Agent + Verifier-retry flow; merging is deferred to a
separate phase after all units settle. The plan-time `owns_paths` overlap
gate is fail-fast — parallel mode refuses overlapping plans before any
dispatch. Merge phase: collect every successful unit's diff, detect textual
conflicts (same file + overlapping old-line ranges + differing new-side
content → structured `MergeConflict`; identical hunks merge cleanly); any
conflict → run `conflicted`, event emitted, nothing merged. Clean plans merge
in plan order via `worktree/merge` + per-unit checkpoint, then a single
Verifier pass runs over the merged result (fail → run `failed` with evidence,
no re-delegation in v1). `orchestrate/resolveConflict` applies
`{conflictIndex, keepUnitId}` resolutions (kept unit's file content wins) and
re-runs the merge phase. Merge is a write op: it goes through the daemon's
`worktree/merge`, which the daemon's policy gate approves, and per-unit merge
events carry a `merge-write` detail tag. Run state persists as one JSON per
run under `~/.sunday/orchestrations/<runId>.json`; `orchestrate/stop` aborts
in-flight units (per-unit `AbortController`, best-effort worktree cleanup);
daemon start reconciles non-terminal runs to `interrupted`.

## Checkpoints & worktrees

Shadow-git repos live outside user repositories
(`~/.sunday/workspaces/<sha256>/checkpoints.git`). Worktree add/list/remove
and merge are exposed over RPC; conflicts abort loudly, never force-merged.

## Browser policy

Localhost allowed by default; `file://` blocked; non-local private IPs
blocked; first navigation to a new public origin needs approval; `eval`
denied by default; `verify_ui` macro for UI checks. No access to the user's
real browser profile.

## Browser agent (`@sunday/browserd` + Agent Browser panel)

browserd is a managed child process of sundayd (crash-isolated, lazy-spawned
on first browser_* tool use, stopped with the daemon). Opt-in only:
`sunday.browser.enabled` (default false) → `SUNDAY_BROWSER_ENABLED=1` at
sidecar spawn; every browser_* tool returns a clear disabled error otherwise.

- **Tools** (sundayd, risk class N): `browser_open/snapshot/click/type/press/
  scroll/wait/eval/screenshot/console/network/close`, `browser_verify_ui`
  (server-ready probe → checks → screenshot → structured report), and
  `browser_walkthrough` (markdown + screenshots under
  `.sunday/artifacts/<session>/`).
- **Observation**: accessibility-tree snapshots with stable `data-sr` refs
  (token-cheap primary observation); screenshots as image content parts.
- **Screencast**: CDP `Page.startScreencast` (jpeg q60, ~2fps) streamed as
  `browser/screencastFrame` notifications; the server caches the last frame
  for `browser/frame/latest` polling (the panel polls at 2fps).
- **Recording**: Playwright video + tracing per session, saved under
  `<session>/media/`; the fake driver writes placeholders.
- **Take over**: `browser/takeover` hands control to the user — the 7 agent
  action tools fail fast with `BrowserTakeover` (-32006) while observation
  (snapshot/console/network/screenshot) stays allowed; `browser/release`
  hands control back.
- **Agent Browser panel** (VS Code bottom panel, `sunday.browserView`):
  live view, URL bar, reload/close, Take over / Resume agent, screenshot
  button. Commands: `sunday.browser.open`, `sunday.browser.takeover`.
- **Security**: domain allow-list enforced server-side in browserd
  (`packages/browserd/src/policy.ts`); `browser_eval` gated by
  `allowEval` (default off at server level); downloads disabled
  (`acceptDownloads: false`); isolated profile dir under `~/.sunday`,
  never the user's real Chrome profile.
- playwright is an **optional peer** of `@sunday/browserd` (lazy dynamic
  import); without it the real driver refuses and the fake driver carries
  all tests. Real Chromium runs on GitHub Actions via
  `npx playwright install chromium`.

## Eval (`@sunday/eval`)

14 deterministic benchmark tasks over the real tool registry
(`sunday-eval run`), reporting pass/fail and tool-call reliability as JSON +
Markdown. `SUNDAY_EVAL_LIVE=1` replays the same tasks against a real model
through sundayd.

## Per-user daemon (Phase 8)

One `sundayd` per OS user instead of one per VS Code window.

```
┌─ VS Code window 1 ─┐   ┌─ VS Code window 2 ─┐   ┌─ sunday CLI ─┐
│  sunday-agent       │   │  sunday-agent       │   │  sunday chat │
└──────┬─────────────┘   └──────┬─────────────┘   └──────┬───────┘
       └──────── socket JSON-RPC (NDJSON framing) ───────┘
              ┌─ sundayd (single, per-user) ─────────────┐
              │  ~/.sunday/sundayd.sock (POSIX)           │
              │  \\.\pipe\sundayd-<user> (Windows)        │
              │  lockfile ~/.sunday/sundayd.lock (single- │
              │  flight: first client spawns detached,    │
              │  rest attach; stale locks stolen)         │
              │  per-workspace trust map (fail-closed)    │
              │  per-workspace MCP hubs + secret scopes   │
              └──────────────────────────────────────────┘
```

- **Transport.** The NDJSON codec is shared (`rpc-transport.ts`); the stdio
  path is unchanged and still works. Socket servers fan notifications out to
  all connected clients; each connection dispatches against the same daemon.
- **Trust model.** `daemon/configure` (or `daemon/set-workspace-trust`) runs
  after `sunday/hello`. Roots are canonicalized (realpath); session cwds
  inherit their workspace's verdict via ancestor-walk. Once any workspace is
  configured, unconfigured paths are untrusted and resolve zero secrets —
  fail-closed. With nothing configured, legacy env-var behavior applies
  (single-workspace mode).
- **Lifecycle.** Dispose detaches only; a client never kills a daemon it
  didn't spawn. Daemon restart reconciles in-flight background/orchestration
  runs to a terminal state.
- Protocol additions: `daemon/configure`, `daemon/set-workspace-trust`,
  `daemon/status`, `mcp/secrets/provide`, `background/run|status|cancel`,
  `background/event`. Shared path/lock helpers live in `@sunday/protocol`
  (`daemon-paths.ts`) so CLI, extension, and daemon agree.

## Hosted gateway (Phase 8, optional)

`@sunday/hosted-gateway`: an inference endpoint for users without their own
provider keys — **not** an agent endpoint. The operator holds the provider
keys; clients get an OpenAI-compatible text-chat API (`GET /health`,
`GET /v1/models`, `POST /v1/chat/completions` with SSE).

- **Text-only by construction.** `tools`/`tool_choice`/`functions` in a
  request → `400`; model-emitted tool chunks are dropped. There is no shell,
  no file access, nothing to execute tools with.
- **Abuse controls:** Bearer API-key auth (constant-time compare; audit logs
  carry truncated SHA-256 fingerprints, never secrets), per-key token-bucket
  rate limits on requests/min and input-tokens/min (`429` + `Retry-After`),
  request size limits, `max_tokens` clamping, model allowlist, IP/CIDR
  allowlist (`X-Forwarded-For` not trusted), one JSONL audit line per request
  (content never logged), upstream timeout with client-disconnect abort.
- Config: `SUNDAY_HOSTED_*` env vars; operator runbook in
  `packages/hosted-gateway/README.md`. Never expose without TLS in front.

## Non-Goals

What Sunday deliberately does *not* try to be:

- **Not a general-purpose agent framework.** Sunday is a coding IDE, not LangChain. The orchestration, tools, and UI are opinionated for software development.
- **Not every IDE.** The primary frontend is the VS Code fork + extension. JetBrains support exists but is explicitly secondary (see Path-to-10 §6).
- **Not OS-level sandboxing in v1.** Tool execution is gated by approvals and (optionally) Docker/bubblewrap, but Sunday does not attempt full OS sandboxing.
- **Not a model provider.** Sunday routes to OpenRouter/Groq; it does not train, host, or serve foundation models.
- **Not offline-first in v1.** API-first means a network connection and provider keys are required (see ADR-004).
