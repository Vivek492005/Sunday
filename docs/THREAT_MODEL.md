# Threat Model — Sunday 0.1.0 hardening

Date: 2026-10-01. This is a STRIDE-lite review of Sunday's six trust
boundaries. The base assumption, inherited from the design doc (§15,
security): **the model is untrusted input; the user's machine is the trust
boundary.** Sunday defends the user's machine, workspace, and credentials
from prompt-injected or malicious model/tool output — not from the user.

## 1. Boundary A — VS Code extension host ↔ sundayd (stdio NDJSON)

The extension spawns sundayd locally and speaks JSON-RPC over stdio.

| STRIDE | Threat | Mitigation / status |
|---|---|---|
| Spoofing | A second local process impersonates sundayd to the extension. | Same-user local machine is not a privilege boundary (documented in `cli.ts`); no cross-user threat. Accepted. |
| Tampering | Malformed NDJSON corrupts the protocol. | `protocol` validates every message with zod schemas; malformed frames are rejected, not executed. |
| Repudiation | `mcp/calls/history` RPC exposes past tool args to the panel. | Same-user surface; args are shown to the user who authorized them. Args may contain pasted secrets — see SEC-07. |
| Info disclosure | Session files on disk hold full history incl. tool args. | **Fixed (SEC-12):** `sessions/` dir is 0700, files 0600. |
| DoS | Runaway agent loops / unbounded tool calls. | `AgentLoop` has `maxIterations`, per-call timeouts, AbortController propagation, and the terminal proxy kills process trees (SIGKILL group / `taskkill /T /F`). |
| Elevation | `policy/approve` RPC approves dangerous tools with no origin check. | Same-user stdio client only — the extension *is* the approver. Accepted by design; documented (SEC-08). |

## 2. Boundary B — sundayd ↔ browserd child process

browserd is a sundayd sidecar; the agent drives a real Chromium via CDP.

| STRIDE | Threat | Mitigation / status |
|---|---|---|
| Spoofing | Attacker page tricks the agent into exfiltrating data (prompt injection via page content). | Tool results are wrapped in `<untrusted_tool_output>` delimiters (SEC-02); the injection-guard system message is always injected (SEC-02); secrets are redacted before reaching the provider (SEC-03). Full taint-escalation (auto-ask on state-changing calls after untrusted content) is **open** (SEC-09). |
| Tampering | Page navigates the agent to `file://` or intranet URLs. | browserd policy blocks `file://` and private IP ranges; first navigation to a new origin requires approval; 21 security tests (SEC-11: DNS rebinding remains a documented limitation). |
| Info disclosure | Agent browser touches the user's real profile/passwords. | Dedicated agent profile; never the user's real browser profile. Takeover mode pauses agent control while the user drives. |
| DoS | Recording/screencast fills disk. | Media is bounded per session under `~/.sunday/browser-sessions/<id>/media`. |

## 3. Boundary C — gateway ↔ OpenRouter / Groq providers

API keys are the crown jewels here.

| STRIDE | Threat | Mitigation / status |
|---|---|---|
| Info disclosure | API key leaks into logs, errors, or prompts. | Keys are read **only** from `OPENROUTER_API_KEY` / `GROQ_API_KEY` env vars, never logged, never written to disk, never interpolated into prompts. Verified in review. |
| Tampering | MITM on provider traffic. | HTTPS only; no custom CA handling; no proxy override in the gateway. |
| DoS | Key exhaustion via runaway retries / parallel agents. | MultiAgentScheduler: round-robin fair queuing, quota wait/resume, P0>P1>P2 priorities, ETA estimates. Retry policy is bounded with backoff. |
| Elevation | Model output influences tool execution (the core agent-loop risk). | PolicyGate allow/deny per autonomy level; dangerous tools require approval. **Fixed (SEC-01):** sub-agent (feature-agent/verifier) loops now share the daemon's PolicyGate instead of a fresh default gate with an empty dangerous set. |

## 4. Boundary D — MCP servers (stdio / Streamable HTTP) ↔ tool execution

Third-party MCP servers run with the user's privileges; their configs live
in workspaces the user may not fully trust.

| STRIDE | Threat | Mitigation / status |
|---|---|---|
| Elevation | Malicious workspace `.sunday/mcp.json` defines a server with `defaultApproval: 'allow'` and dangerous tools; sundayd auto-starts it (arbitrary stdio process spawn) and auto-approves. | **Fixed (SEC-04):** workspace MCP configs now load **only** when `isWorkspaceTrusted()` is true (VS Code workspace trust). Previously the default was fail-open (`workspaceTrusted: true` unconditionally). In untrusted workspaces the config is ignored entirely. |
| Tampering | MCP server returns malicious tool descriptions/output that steer the agent. | Same untrusted-output pipeline as Boundary B (delimiters + redaction + guard). Tool results from MCP servers pass through `wrapUntrustedToolOutput`/`redactSecrets`. |
| Info disclosure | MCP secrets (`secret:KEY` refs) leak into logs or prompts. | Secrets are resolved from `SUNDAY_MCP_SECRET_*` env at call time and never inlined into configs, logs, or tool results. |
| DoS | Malicious server hangs `hub.callTool`. | Per-call timeouts + AbortController; on-demand server start is bounded. |

## 5. Boundary E — webviews (chat, MCP panel, orchestration) ↔ extension host

| STRIDE | Threat | Mitigation / status |
|---|---|---|
| Spoofing/XSS | Attacker-controlled content (tool output rendered in chat) executes JS in the webview. | VS Code webviews run with a restrictive CSP; chat renders tool output as text, and the `<untrusted_tool_output>` delimiters make provenance explicit. |
| Info disclosure | Webview state (API keys, secrets) leaks via `postMessage` to the wrong handler. | Webviews never receive raw API keys — only the sundayd process holds them. |

## 6. Boundary F — agent-run shell commands ↔ user machine

`run_terminal` is the single most powerful tool in the loop.

| STRIDE | Threat | Mitigation / status |
|---|---|---|
| Tampering | Symlink escape: a symlinked path passes lexical confinement checks and the agent reads/writes outside the workspace. | **Fixed (SEC-05):** `resolveWithinRoot` now canonicalizes via `realpath` on the nearest existing ancestor (design §15.2); symlink file/dir escapes are rejected, inner symlinks still work. |
| Tampering | Destructive shell commands (`rm -rf`, etc.). | Terminal is a dangerous tool: requires approval per autonomy level; process-tree kill on timeout. A sandbox execution mode exists (`SandboxConfig` on the tool context; `run_terminal` is the single decision point). |
| Info disclosure | `.env` / key files read into context and echoed to the provider. | **Partially fixed (SEC-03):** all tool output is secret-redacted before it reaches the model. Ask-gating on credential-file reads (design §15.2, class R+) is **open** (SEC-10). |
| Repudiation | Destructive commands not attributable. | Terminal output + commands are recorded in the session transcript (now 0600, SEC-12). |

## Findings register

| ID | Boundary | Threat | Severity | Status | Evidence |
|---|---|---|---|---|---|
| SEC-01 | C | Sub-agent loops used a fresh default PolicyGate → dangerous tools executed unapproved | High | **Fixed** | `daemon.ts`: shared `policyGate` + `syncDangerousFlags`; `policy-bypass.test.ts` (2) |
| SEC-02 | B, D | Tool output fed to the model with no untrusted delimiters | Medium | **Fixed** | `untrusted.ts`, `INJECTION_GUARD` in `system-prompt.ts`; `untrusted.test.ts` (5) |
| SEC-03 | B, D, F | No secret redaction on tool results before the provider | Medium | **Fixed** | `redactSecrets()` in `skills/memory.ts`, wired in `loop.ts executeCall`; `loop-security.test.ts` (4) |
| SEC-04 | D | Workspace MCP config loaded even in untrusted workspaces (fail-open) | High | **Fixed** | `agent-tools.ts`/`cli.ts`: fail-closed on `isWorkspaceTrusted()`; `agent-tools.test.ts` SEC-04 (4) |
| SEC-05 | F | Symlink escape in `resolveWithinRoot` (lexical check only) | High | **Fixed** | `tools/paths.ts`: realpath canonicalization; `tools.test.ts` (3 new) |
| SEC-06 | D | `defaultApproval: 'allow'` in workspace MCP config auto-approves dangerous tools | Medium | Mitigated | Only reachable in *trusted* workspaces after SEC-04; the user's trust decision is explicit there. |
| SEC-07 | A | `mcp/calls/history` argsSummary may hold user-typed secrets | Low | **Fixed** | `hub.ts` `recordCall()` applies `redactSecrets()` to `argsSummary`; `mcp.test.ts` SEC-07 test. See `docs/SECURITY_DISPOSITIONS.md`. |
| SEC-08 | A | `policy/approve` has no origin check | Low | Accepted | Same-user stdio client is not a privilege boundary (documented). |
| SEC-09 | B, D | No taint escalation (state-changing call right after untrusted content → ask) | Medium | Deferred | Delimiters + guard landed; full taint tracking is post-beta. See `docs/SECURITY_DISPOSITIONS.md`. |
| SEC-10 | F | Credential-file reads (`.env`, `*.pem`) not ask-gated (design §15.2 class R+) | Low | Deferred | Output redaction (SEC-03) contains the blast radius; ask-gating is post-beta. See `docs/SECURITY_DISPOSITIONS.md`. |
| SEC-11 | B | Browser policy: DNS rebinding can bypass private-IP block | Low | Accepted | Documented limitation; real-Chromium verification pending. See `docs/SECURITY_DISPOSITIONS.md`. |
| SEC-12 | A | Session files world-readable; full history incl. tool args on disk | Medium | **Fixed** | `sessions.ts`: 0700 dir + 0600 files; `sessions-permissions.test.ts` (1) |

## Residual risk statement

After this hardening pass, the highest remaining risks are **SEC-09**
(taint escalation) and **SEC-11** (DNS rebinding) — both documented,
neither trivially exploitable without a motivated attacker's page in the
loop. The supply-chain surface is audited separately in
`docs/SECURITY_AUDIT.md`; the machine-readable inventory is
`docs/sbom.json`.
