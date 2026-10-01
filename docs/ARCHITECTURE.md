# Sunday architecture (condensed)

> Full design doc uses the old product name AURORA; the rename mapping is in
> [NAMING.md](NAMING.md). This file describes the system as built.

## Pieces

```
┌─ VS Code ──────────────────────────────┐
│  sunday-agent (built-in extension)      │  TypeScript, esbuild bundle
│   ├─ chat webview      (@sunday/ui-chat)
│   └─ manager webview   (@sunday/ui-manager)
└────────────── stdio JSON-RPC ──────────┘
┌─ sundayd (sidecar) ────────────────────┐  Node, NDJSON/stdio, single file
│  sessions │ agent loop │ policy gate    │  in the packaged build
│  checkpoints (shadow git) │ worktrees   │
│  orchestration host │ context │ artifacts
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

## Orchestration (`@sunday/orchestrator` + sundayd host)

`orchestrate/plan` decomposes a goal into ≤ 8 contracted units (validated
JSON, unique ids, static `owns_paths` overlap rejection, ADR-18 budget).
`orchestrate/run` executes sequentially (v1): one worktree per unit, Feature
Agents get full tool access, a fresh Verifier gets a read-only registry plus
the diff and acceptance criteria. Pass → `--no-ff` merge + checkpoint;
fail → two retries, then continue. The daemon implements
`DaemonOrchestratorHost.runSubAgent` so the orchestrator never imports the
daemon (no import cycle).

## Checkpoints & worktrees

Shadow-git repos live outside user repositories
(`~/.sunday/workspaces/<sha256>/checkpoints.git`). Worktree add/list/remove
and merge are exposed over RPC; conflicts abort loudly, never force-merged.

## Browser policy

Localhost allowed by default; `file://` blocked; non-local private IPs
blocked; first navigation to a new public origin needs approval; `eval`
denied by default; `verify_ui` macro for UI checks. No access to the user's
real browser profile.

## Eval (`@sunday/eval`)

10 deterministic benchmark tasks over the real tool registry
(`sunday-eval run`), reporting pass/fail and tool-call reliability as JSON +
Markdown. `SUNDAY_EVAL_LIVE=1` replays the same tasks against a real model
through sundayd.
