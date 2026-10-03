# Phase 8 Plan — Per-User Agent Daemon

**Status:** Stages 1–3 implemented (uncommitted). Stage 4 pending.
**Date:** 2026-10-03
**Design refs:** `~/workspace/user/files/merged_step1.md` §5.3 ("In v1.2 a per-user **daemon** (named pipe/unix socket) keeps background agents alive; windows attach/detach"), §28 (Phase 8 backlog)

---

## 1. Current architecture (per-window sidecar)

### 1.1 Spawn path

```
VS Code window (extension host)
  └─ extension.ts activate()
       └─ new SidecarManager({ extensionDir, clientVersion, readConfig, log, extraEnv })
            └─ spawn(node sundayd.mjs | dist/cli.js, stdio: ['pipe','pipe','pipe'])
                 └─ NDJSON JSON-RPC over stdio (RpcClient in packages/ext-agent/src/rpc.ts)
                      └─ sunday/hello handshake (protocol version negotiation)
```

- **One sundayd process per VS Code window.** Two windows = two daemons (~41.5 MB idle RSS each), two MCP hub inits, two provider registries.
- `SidecarManager` (`packages/ext-agent/src/sidecar.ts`, 391 lines): discovery (setting → bundled → workspace → PATH), spawn, handshake, crash backoff (3 rapid crashes → `crashed` status), clean shutdown (`sunday/shutdown` RPC → drain → SIGTERM → SIGKILL).
- `RpcClient` (`packages/ext-agent/src/rpc.ts`): constructed around a `ChildProcess`; parses NDJSON frames from stdout, writes requests to stdin, routes `chat/event` notifications to the single client.

### 1.2 Per-window configuration (env vars stamped at spawn)

| Env var | Source | Used by |
|---|---|---|
| `SUNDAY_WORKSPACE` | workspace root of the window | daemon: default workspace for MCP hub (`~/.sunday/mcp.json` → actually `<ws>/.sunday/mcp.json`), context handlers |
| `SUNDAY_WORKSPACE_TRUSTED` | workspace trust prompt | `isWorkspaceTrusted()` — gates workspace skills with scripts (SEC-04 fail-closed) |
| `SUNDAY_BROWSER_ENABLED` | `sunday.browser.enabled` setting | `BrowserdManager` opt-in gate |
| `SUNDAY_SANDBOX_MODE` / `SUNDAY_SANDBOX_DOCKER_IMAGE` | `sunday.sandbox.*` settings | `sandboxConfigFromEnv()` for `run_terminal` |
| `SUNDAY_MCP_SECRET_*` | pre-resolved MCP secrets | `EnvSecretResolver` |

**Problem for sharing:** all of these are *process-global* in sundayd today. A per-user daemon serving multiple windows/workspaces cannot read them from env.

### 1.3 Session model

- `SessionStore` (`packages/sundayd/src/sessions.ts`): in-memory `Map<uuid, StoredSession>` + one JSON file per session under `~/.sunday/sessions/<uuid>.json` (0600 per Hardening phase).
- `session/create {title?, cwd?, model?}` → UUID; `session/list|restore|close`; agent turns run against a session's `cwd`.
- Sessions are **workspace-agnostic at the daemon layer** — the `cwd` confines tools, and `context/*` takes an explicit per-call `workspaceRoot`. This is already multi-workspace-friendly.
- **Gap:** two daemons (two windows) share the same `~/.sunday/sessions/` dir. In-memory state is per-process; concurrent writes to the same session file from two daemons could interleave (no file locking today). In practice each window uses its own sessions, so this rarely bites — but a shared daemon must own the store exclusively.
- Orchestration runs: module-level registry in `@sunday/orchestrator` + file persistence under `~/.sunday/orchestrations/`; `reconcileOrchestrationRuns` on startup. Already restart-safe.

### 1.4 Shutdown semantics today

Window closes → extension host deactivates → `SidecarManager.dispose()` → `stop()` → `sunday/shutdown` RPC (drains in-flight session persists) → SIGTERM → SIGKILL fallback. **All agent runs stop with the window** (design §5.3: "in MVP all runs stop (state saved)").

### 1.5 What already helps

- NDJSON framing is transport-agnostic (works over any byte stream).
- `sunday/hello` negotiates versions — reusable for socket clients.
- `sunday/shutdown` + `gracefulExit()` (drains session writes) — reusable for daemon lifecycle.
- `sunday/ping` exists for health checks.
- Session files are the durable truth; `restore` rebuilds in-memory state.

---

## 2. Target architecture (per-user daemon)

### 2.1 Topology

```
OS user session
  └─ sundayd --daemon  (ONE process per user)
       ├─ Unix socket: ~/.sunday/sundayd.sock  (0600, dir 0700)
       └─ Windows: named pipe \\.\pipe\sundayd-<username>
            ├─ VS Code window A (workspace /home/u/proj1) ── attach
            ├─ VS Code window B (workspace /home/u/proj2) ── attach
            ├─ JetBrains frontend (Phase 8) ── attach
            └─ sunday CLI (Phase 8) ── attach
```

### 2.2 Transport

- **Same NDJSON JSON-RPC**, but over a socket instead of stdio pipes. `RpcClient` needs a transport abstraction: today it takes `ChildProcess`; add a variant taking a `net.Socket` (POSIX) / named-pipe handle (Windows). Framing, request IDs, notification routing stay identical.
- Daemon gains `--socket <path>` mode alongside `--stdio` (default today). In socket mode it `listen()`s instead of reading stdin.
- Windows named pipes via `net.createServer('\\\\.\\pipe\\sundayd-<user>')` — Node supports this; ACLs default to creator-only, which is what we want (same-user).

### 2.3 Single-flight startup (no double daemon)

- Lockfile `~/.sunday/sundayd.lock` containing `{pid, socketPath, version, startedAt}`.
- Extension connect flow:
  1. Read lockfile → try `sunday/hello` over the socket (short timeout).
  2. If reachable and protocol-compatible → attach.
  3. If stale (PID dead) or absent → acquire an OS-level lock (`fs.open` with `wx` on a `.lock` file), spawn `sundayd --daemon` **detached** (`detached: true, stdio: 'ignore'`), wait for socket, release lock.
- Race safety: the `wx` exclusive-create is the mutex; losers fall back to connect-retry.

### 2.4 Attach/detach protocol (new RPCs)

| RPC | Params | Effect |
|---|---|---|
| `daemon/attach` | `{clientId, clientName, clientVersion, workspaceRoot?, capabilities?}` | Registers a client; returns `{daemonVersion, negotiated}`. Daemon refcounts. |
| `daemon/detach` | `{clientId}` | Unregisters; decrements refcount. |
| `daemon/status` | `{}` | `{clients: [...], uptime, sessions, runs}` — for diagnostics/CLI. |

- Every subsequent RPC carries an implicit client identity (per-connection state on the socket — no need to thread `clientId` through every call).
- **Notifications routing:** `chat/event` notifications today go to the single stdio client. With N clients, the daemon tracks which client owns which session (`session/create` is called on a given connection → that connection gets that session's events). Orchestration/conflict events go to all clients attached with the same `workspaceRoot`, or to all (TBD — default: owning client + clients sharing the workspace).

### 2.5 Env vars → per-workspace/per-session config

This is the biggest semantic change. Each item needs a new home:

| Today (env) | Target |
|---|---|
| `SUNDAY_WORKSPACE` | Daemon keeps a `workspaceRoot → WorkspaceContext` map. `daemon/attach` supplies the window's workspace root; session `cwd` already confines tools per-call. |
| `SUNDAY_WORKSPACE_TRUSTED` | Per-workspace trust map in the daemon, keyed by normalized root path. Trust is a user decision per workspace — the extension prompts, then calls `daemon/setWorkspaceTrust {root, trusted}` (new RPC) or passes it in `attach`. |
| `SUNDAY_BROWSER_ENABLED` | Daemon-global is fine (it's a user setting, not per-workspace). Move to `daemon/configure {browserEnabled}` or keep as daemon-start flag. |
| `SUNDAY_SANDBOX_MODE/IMAGE` | Same — user-level setting → daemon config RPC. |
| `SUNDAY_MCP_SECRET_*` | Per-workspace MCP configs already live in `<ws>/.sunday/mcp.json`; secrets must be supplied per workspace. Extension resolves secrets for its workspace and calls `mcp/secrets/provide {workspaceRoot, secrets}` (new RPC) after attach. The daemon's `EnvSecretResolver` becomes a per-workspace secret store. |

### 2.6 MCP hub per workspace

Today: one `McpHub`, daemon-global, reads `<SUNDAY_WORKSPACE>/.sunday/mcp.json`.
Target: `Map<workspaceRoot, McpHub>` — hub per workspace, lazily created on first `mcp/*` call or `attach`. Each hub gets its workspace's secrets. Memory cost is per-workspace servers, which matches today's per-window cost.

### 2.7 Lifecycle: outliving windows

Design intent: "keeps background agents alive; windows attach/detach."

- Daemon does **not** exit when the last window detaches. It keeps running agent loops/orchestrations.
- Shutdown paths:
  - Explicit: `sunday/shutdown` RPC (kept; now means "shut down the user daemon"). Extension command "Sunday: Stop Daemon". CLI `sundayd --shutdown`.
  - Idle: configurable `daemon.idleShutdownMinutes` (default: 0 = never). Only fires when: zero attached clients AND zero running agent turns/orchestrations AND zero browser sessions.
  - Crash: unchanged — but now a daemon crash affects all windows; each extension's `SidecarManager` equivalent (now a `DaemonConnector`) runs the hello-retry loop and re-attaches (sessions rehydrate from disk via `session/restore`).
- On OS logout: daemon gets SIGTERM → existing `gracefulExit()` drains session persists. Optionally install a user-level autostart entry (deferred — "start on login" is Stage 4).

### 2.8 Version skew

Multiple VS Code windows may run different sunday-agent versions (e.g. one stable, one dev). The daemon advertises its version in `daemon/attach` response; the extension compares against its bundled protocol. Policy: daemon speaks the **max protocol it knows**; `sunday/hello` negotiation already handles minor skew. If major mismatch → extension falls back to spawning a private `--stdio` sidecar (today's behavior) and warns. This keeps the upgrade path safe.

---

## 3. Required changes (files)

### `packages/sundayd/` (daemon)

| File | Change |
|---|---|
| `src/cli.ts` | Add `--daemon` / `--socket <path>` / `--shutdown` flags (arg parsing). |
| `src/daemon.ts` | Add socket listener (`net.createServer`), per-connection client table, `daemon/attach|detach|status`, `daemon/setWorkspaceTrust`, `daemon/configure`. Notification routing by session→client. |
| `src/sessions.ts` | Add `ownerClientId` / `workspaceRoot` attribution to `StoredSession` (for routing + UI filtering). File-lock or atomic-write guard for the sessions dir (exclusive ownership is now guaranteed, but harden anyway). |
| `src/agent-tools.ts` | `EnvSecretResolver` → per-workspace secret store. |
| `src/mcp-methods.ts` + hub | Per-workspace `McpHub` map. |
| `src/trust.ts` | `isWorkspaceTrusted()` (env-based) → trust map keyed by workspace root. |
| `src/rpc-transport.ts` *(new)* | Shared NDJSON framing over `net.Socket` (extract from stdio path so both use it). |
| `src/daemon-spawn.ts` *(new)* | Single-flight spawn helper: lockfile, `wx` mutex, detached spawn, socket wait. Used by CLI `--daemon` self-check and potentially by a `sundayd` launcher. |

### `packages/ext-agent/` (extension)

| File | Change |
|---|---|
| `src/sidecar.ts` | Add `DaemonConnector` (or extend `SidecarManager`): connect-first (`sunday/hello` over socket) → single-flight spawn fallback → `daemon/attach`. Keep `SidecarManager` for the version-skew fallback path (private stdio sidecar). |
| `src/rpc.ts` | `RpcClient` transport abstraction: accept `ChildProcess` (today) or `net.Socket` (new). Same NDJSON codec. |
| `src/extension.ts` | Replace `new SidecarManager(...)` with connector; pass `workspaceRoot` in `attach`; move trust prompt result into `daemon/setWorkspaceTrust`; move MCP secret pre-resolution into `mcp/secrets/provide` after attach. |
| `src/hostBridge.ts` | Session listing: filter by workspace (`session/list {workspaceRoot?}`) so each window sees its own sessions (plus an "all" toggle later). |

### Protocol (`packages/protocol/`)

- New methods: `daemon/attach`, `daemon/detach`, `daemon/status`, `daemon/setWorkspaceTrust`, `daemon/configure`, `mcp/secrets/provide`.
- `SessionCreateParams` gains optional `workspaceRoot` (defaults to the attaching client's).
- `session/list` gains optional `workspaceRoot` filter.

### No `vscode/` core changes

Everything is extension + daemon side. **Zero divergence budget.**

---

## 4. Risks

| Risk | Likelihood / Impact | Mitigation |
|---|---|---|
| Socket path races (two windows spawn two daemons) | Med / High | `wx` exclusive lockfile as mutex; stale-PID detection; connect-retry for losers. |
| Notification misrouting (window A sees window B's agent output) | Med / Med | Session→client attribution at `session/create`; default-deny (events go only to owning client unless workspace-shared and opted in). |
| MCP secret leakage across workspaces | Low / **Critical** | Per-workspace secret stores; never log secrets (existing redaction); socket dir 0700. |
| Version skew (old extension, new daemon or vice versa) | Med / Med | `daemon/attach` version check; fallback to private stdio sidecar on major mismatch. |
| Daemon crash takes down all windows | Low / High | Existing session persistence + `restore`; connector re-attaches with backoff; crash telemetry. |
| Windows named-pipe quirks (ACLs, name length) | Med / Low | Pipe name `\\.\pipe\sundayd-<username>` (short); test on CI Windows runner. |
| Orphaned daemon after crashes (lockfile stale, socket dead) | Med / Low | PID liveness check on lockfile; `--shutdown` cleanup; idle-shutdown default off initially. |
| Resource use (one daemon, many workspaces' MCP servers) | Low / Med | Per-workspace hubs are lazy; idle hub shutdown after timeout (later stage). |

---

## 5. Staged implementation

### Stage 1 — Socket transport, same topology (recommended first)
- Extract NDJSON codec into `packages/sundayd/src/rpc-transport.ts` (shared by stdio + socket).
- Daemon: `--socket <path>` listen mode.
- Extension: `RpcClient` accepts a `net.Socket`; `DaemonConnector` with connect-first → spawn `--socket` fallback (still **one daemon per window** at this stage).
- Tests: loopback socket round-trip, hello over socket, notifications over socket.
- **Why first:** de-risks the transport without touching lifecycle, trust, or MCP. Everything else builds on it. No behavior change for users.

### Stage 2 — Single-flight per-user daemon
- Lockfile + `wx` mutex + detached spawn (`sundayd --daemon`).
- `daemon/attach|detach|status` RPCs; refcount; daemon ignores window-close (no auto-shutdown on detach).
- Extension: `SidecarManager` → `DaemonConnector` as the default path; keep stdio `SidecarManager` as version-skew fallback.
- Session `workspaceRoot` attribution; `session/list` filter.
- **Visible win:** second window opens instantly (no 800 ms daemon cold start, no duplicate 41.5 MB).

### Stage 3 — Multi-workspace correctness ✅ IMPLEMENTED (2026-10-04, uncommitted)
- Per-workspace trust map (`daemon/set-workspace-trust`), per-workspace MCP hubs + secret stores (`mcp/secrets/provide`).
- `SUNDAY_WORKSPACE*` env vars remain as single-workspace fallback (backward compat).
- Notification routing rules finalized (owning client + workspace peers) — *deferred to Stage 4*.
- Tests: two workspaces, different trust verdicts, isolated MCP servers. ✅

### Stage 4 — Lifecycle polish
- Idle shutdown (`daemon.idleShutdownMinutes`), `sundayd --shutdown`, "Sunday: Stop Daemon" command.
- Optional OS-login autostart (deferred; needs installer work per platform).
- Crash telemetry + re-attach backoff tuning.
- JetBrains/CLI frontends can now attach (their own Phase 8 items).

---

## 6. Recommended first step

**Implement Stage 1:** socket transport with no topology change.

Concrete first commit:
1. `packages/sundayd/src/rpc-transport.ts` (new): `createNdjsonSocketTransport(socket)` — line framing, request/response correlation, notification emit. Refactor the stdio path in `daemon.ts` to use the same codec.
2. `packages/sundayd/src/cli.ts`: `--socket <path>` flag → `net.createServer` instead of stdio loop.
3. `packages/ext-agent/src/rpc.ts`: `RpcClient.fromSocket(socket)` factory alongside the `ChildProcess` constructor.
4. `packages/ext-agent/src/daemon-connector.ts` (new): try socket `sunday/hello` → fall back to spawning `sundayd --socket <tmp>` for this window only.
5. Tests: `rpc-transport.test.ts` (framing), socket hello round-trip, notification delivery.

No protocol changes needed in Stage 1 (attach/detach come in Stage 2). No `vscode/` changes. Pushable without PAT-dependent CI (local tests only).
