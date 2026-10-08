# Sunday IDE + Agent — Data-Flow Privacy Audit (Master Report)
**Date:** 2026-10-07 · **Auditors:** 5 parallel code-read audits (read-only, nothing modified)
**Scope:** `~/workspace/sunday-product` — sundayd, gateway, ext-agent, hosted-gateway, browserd, MCP/skills, VS Code fork config, landing page
**Method:** Source-code reading only. Every finding cites a file. "Not found in code" is stated where unverifiable.

---

## 1. Data Flow Map

```
USER'S MACHINE
┌─────────────────────────────────────────────────────────────────┐
│ IDE (VS Code fork)                                              │
│  ext-agent: chat composer, @mentions, autocomplete, inline edit, │
│             code actions, terminal explain, commit-msg           │
│  sunday-google-auth: OAuth tokens → VS Code SecretStorage       │
│  Webviews: CSP-locked; frame imgs local only                    │
│        │  local socket (0600 POSIX)                             │
│        ▼                                                        │
│ sundayd (daemon)                                                │
│  AgentLoop: prompts → router; tool results → redactSecrets      │
│             → <untrusted_tool_output> → provider                │
│  Session store → ~/.sunday/sessions/<id>.json (0600)            │
│  Checkpoints → ~/.sunday/workspaces/<sha>/checkpoints.git       │
│  Memory/skills/rules → system prompt injection                  │
│  Browserd (Chromium, isolated profile) → screenshots in memory; │
│      page TEXT (incl. input values) → tool output → provider    │
│        │  HTTPS (BYOK keys env-only; hosted: OAuth Bearer)      │
│        ▼                                                        │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
HOSTED GATEWAY (operator's server, e.g. Render)
  Auth: OAuth-token verify (GitHub/Google/MS userinfo) OR static key
  Per request: quota (in-mem, UTC midnight), rate-limit buckets,
               token estimate = promptChars/4
  Audit log → stdout/file: ts, requestId, keyId(= key + label),
              ip, model, status, latency, token estimates
  Upstream → OpenRouter/Groq with OPERATOR's keys
         │
         ▼
THIRD-PARTY PROVIDERS (OpenRouter / Groq / Ollama-local)
  Receive: full prompt text (verbatim, possibly truncated),
           images as data URLs, tool definitions.
  Their data policies apply — Sunday code cannot constrain them.
```

### What → Where → Why

| # | What leaves/stored | Where it goes | Why |
|---|---|---|---|
| 1 | Chat messages + @mention expansions (full files, diffs, selections) | Provider (OpenRouter/Groq/hosted/Ollama) | Agent needs context to answer |
| 2 | Autocomplete prefix (2000 ch) + suffix (500 ch) per keystroke burst | Provider FIM endpoint | Ghost-text completions |
| 3 | Inline edit payload (selection or whole doc), code-action code (16k), terminal output (6k), staged diff (8k) | Provider | Edit/fix/explain/commit features |
| 4 | Tool outputs (file reads up to 50MB, terminal up to 200kB, MCP results, browser page text) | Provider (after `redactSecrets` + untrusted delimiters) | Agent loop needs results |
| 5 | Browser snapshot text incl. **input values** (incl. `type=password`) | Provider (via tool text output) | Agent needs page state |
| 6 | Screenshots/screencast frames | Memory only → local webview; **not** sent to provider | Agent Browser panel |
| 7 | Full session history (unredacted user msgs) | `~/.sunday/sessions/*.json` (0600) | Resume/crash recovery |
| 8 | Full workspace snapshots (`git add -A`) | `~/.sunday/workspaces/*/checkpoints.git` (default perms) | Undo/restore |
| 9 | Per-request metadata: IP, email/UPN/login, model, token counts | Gateway audit log (stdout/file, unbounded) | Abuse monitoring, quota |
| 10 | Quota identifiers `gh:<id>`/`google:<sub>`/`ms:<id>` | Gateway in-memory Map (until UTC midnight) | Daily free-tier quota |
| 11 | Raw OAuth token → identity (5-min cache) | Gateway in-memory Map (token as plaintext key) | Avoid re-verifying per request |
| 12 | OAuth refresh tokens | VS Code SecretStorage (Google extension) | Silent re-auth |
| 13 | MCP server secrets | VS Code SecretStorage; `SUNDAY_MCP_SECRET_*` env at sidecar spawn (in-memory) | MCP auth |
| 14 | BYOK API keys | Env vars only, never disk | Provider auth |
| 15 | Memory notes, skills, AGENTS.md rules | System prompt (every session) → provider | Agent personalization |
| 16 | Browser recordings (video.webm, trace.zip), Chromium profile (cookies) | `~/.sunday/browser-sessions/`, `~/.sunday/browser/` (default perms, forever) | Debugging, persistent logins |
| 17 | Context index (full file text chunks) | `~/.sunday/index/*.json` (default perms) | Fast repo map |
| 18 | Orchestration state (goal text, errors, diff hunks) | `~/.sunday/orchestrations/*.json` (0644) | Parallel agent runs |

---

## 2. Concerns (rated)

### CRITICAL

**C1 — Unredacted exfiltration surface on user-initiated paths.** The only outbound filter (`redactSecrets` in `packages/skills/src/memory.ts:114`) applies to *agent-loop tool results only* (`sundayd/src/loop.ts:192-197`). These go to the provider with **zero redaction**: ghost-text prefix/suffix (`ext-agent/src/inlineCompletion.ts:48-49`, `sundayd/src/completion.ts`, `gateway/src/openai-compatible.ts:106-171`), @file/@selection/@git-diff expansions (`ext-agent/src/mentions.ts`, composed in `chatView.ts:179-196`), inline edit (`inlineEdit.ts:buildEditPrompt`), code actions (`codeActions.ts`, 16k cap), terminal-explain (`terminalExplain.ts:24`), commit prompts (`gitCommit.ts:22`). Typing a secret into `.env` with ghost text on sends it verbatim to OpenRouter/Groq/hosted gateway. No preview of expanded mentions before send.

### HIGH

**H1 — SEC-10 credential ask-gate and SEC-09 taint are dead code.** `sundayd/src/credential-gate.ts` has zero call sites outside its own tests; `sundayd/src/taint.ts` likewise unreferenced. Docs claim "approval required before reading `.env`" — the agent reads credential files with no approval today. Dead security code that docs claim is active is worse than none.

**H2 — Browser snapshot captures `type=password` values and sends them to the AI provider.** `SNAPSHOT_SCRIPT` (`packages/browserd/src/playwright-driver.ts`) captures `.value` for textbox/combobox roles including `type=password`; `formatSnapshot` (`packages/sundayd/src/browser-tools.ts`) renders `value="…"` into tool **text** output; `loop.ts` sends tool text to the model. (Screenshots themselves are correctly dropped — `loop.ts:139-146`.)

**H3 — Checkpoints duplicate the full workspace (incl. `.env`, `*.pem`) at world-readable default permissions.** `CheckpointManager.create` runs `git --git-dir <shadow> --work-tree <root> add -A` (`sundayd/src/checkpoints.ts:155`) → `~/.sunday/workspaces/<sha256>/checkpoints.git`. No chmod anywhere in the checkpoint path. On a multi-user machine, another user can `git show` your secrets. Sessions got 0600 (SEC-12); checkpoints were missed.

**H4 — `redactSecrets` misses Sunday's own provider key shapes.** 15 regexes cover `sk-`, `ghp_`, `AKIA`, etc. — but NOT OpenRouter `sk-or-v1-…`, NOT Groq `gsk_…`, no JWT pattern, no generic high-entropy `KEY=value` catch-all (`packages/skills/src/memory.ts:54-69`). An `env`/`printenv` tool output leaks BYOK keys to the provider unredacted.

**H5 — User messages bypass all filtering.** `runTurn` pushes user content verbatim (`sundayd/src/loop.ts:100-102`). `@file .env` in the IDE ships the full `.env` to the provider — no credential warning, no redaction, no confirm (`ext-agent/src/mentions.ts:162-172`).

**H6 — Context index stores full file contents at default perms, only `.gitignore`-gated.** `packages/context/src/indexer.ts:100` writes `text: body` for every text file; a `.env` not gitignored is indexed verbatim under `~/.sunday/index/`, world-readable.

**H7 — Webviews phone Microsoft's CDN.** `webviewContentExternalBaseUrlTemplate` in `vscode/product.json` points to `https://{{uuid}}.vscode-cdn.net/...`. Every webview load does DNS+TLS to Microsoft infra and leaks the exact upstream VS Code commit the fork was cut from.

### MEDIUM

**M1 — Gateway audit log writes PII into every line.** For social users `keyId = "<key> (<label>)"` where label = GitHub login / Google **email** / MS UPN (`hosted-gateway/src/server.ts`, `audit.ts`). The `audit.ts` docstring claims "key fingerprint (never the secret)" — false for labels. On Render/Railway stdout = platform log drain with platform-defined retention.

**M2 — Raw OAuth tokens stored in plaintext as in-memory cache keys (5 min).** `hosted-gateway/src/social-auth.ts:93-131`: `const cacheKey = token`. A core dump / memory inspection yields live user tokens.

**M3 — `removeSession` revokes the access token but NOT the refresh token.** Google refresh tokens are long-lived; revoking only the access token leaves a valid credential at Google after "sign out" (`vscode/extensions/sunday-google-auth/src/extension.ts`). Mitigated only by local SecretStorage deletion.

**M4 — Orchestration state at 0644 with secret-carrying fields.** `~/.sunday/orchestrations/<runId>.json`: goal text, error strings, diff hunks (`packages/orchestrator/src/state.ts` — mkdir/writeFile without mode).

**M5 — Browser recordings + Chromium profile at default perms, retained forever.** `video.webm`/`trace.zip` (screenshots + DOM snapshots incl. input values) and per-workspace cookies/storage (`packages/browserd/src/server.ts:358`, `playwright-driver.ts:106`). No cleanup code anywhere.

**M6 — Relay silently re-routes conversations to a different vendor.** `gateway/src/router.ts` + `policies.ts`: on 429/5xx the same conversation goes to another provider (BYOK ↔ Sunday-hosted) without re-consent.

**M7 — No retention anywhere.** Sessions, checkpoints, orchestrations, recordings, index accumulate forever; `SessionStore.close()` keeps the file; **no session-delete API** exists.

**M8 — Takeover mode keeps the agent's eyes open.** Screenshot/screencast/recording continue while the user drives the browser; only *actions* are blocked (`packages/browserd/src`). A user logging in during takeover is captured on video + trace.

**M9 — DNS rebinding gap in browser URL policy.** Lexical classification only (`packages/browserd/src/policy.ts`); a "public" hostname resolving to a private IP is not detected.

**M10 — Socket chmod skipped on Windows.** `~/.sunday/sockets/` is 0600 on POSIX (`sundayd/src/cli.ts:314`) but skipped on win32 — the `daemon/configure` OAuth token is more exposed on Windows.

**M11 — Memory injected into system prompt unredacted.** Write-time refusal exists (`skills/src/memory.ts`), but a manually-edited `~/.sunday/memory.md` flows into every session's prompt (`sundayd/src/system-prompt.ts:73-76`).

**M12 — Google `profile` scope over-broad; `access_type=offline`+`prompt=consent` accumulates refresh tokens** on the user's Google account page. Gateway only consumes `sub`+`email` (`openid email` suffices).

**M13 — Dead `telemetry.*` settings remain in Settings UI**, implying controls that do nothing.

### LOW

**L1** — Gateway: IPv6 CIDR unsupported in allowlist; 8-hex-char `requestId` collision-prone; quota fail-open on restart; negative-cache fans out to all providers' userinfo endpoints.
**L2** — Landing page fetches `api.github.com` on load (IP exposure, no tracking vectors).
**L3** — Walkthrough `step-N.png` artifacts persist in workspace `.sunday/artifacts/` (default perms).
**L4** — Agent-browser profile cookies persist per workspace indefinitely; no `browser/profile/clear` action.
**L5** — `memory.md` files at default perms (write-time secret refusal limits risk).

---

## 3. What's Done vs Missing

| Area | Done (verified in code) | Missing |
|---|---|---|
| Telemetry | Disabled: no `enableTelemetry`/`aiConfig`/`tasConfig` in product.json; `NullTelemetryService`; no analytics calls in ext-agent/sundayd | Remove dead `telemetry.*` settings from UI; packet-capture verification |
| Updates | Disabled: no `updateUrl` → update service permanently inert | In-app update notices (trade-off acknowledged) |
| Crash reporting | Inert: no `crashReporter.start`, no submitURL | Nothing |
| Extension gallery | Open VSX (not Microsoft); machine IDs gated on telemetry → not sent | Fix gallery description text ("Microsoft online service") |
| Session files | 0700 dir / 0600 files (`sessions.ts:41,112`), tested | Apply same to checkpoints, orchestrations, index, recordings |
| BYOK keys | Env-only, never disk (`gateway/src/providers.ts:143,171`) | Nothing |
| OAuth token (IDE→daemon) | In-memory only (`daemon.ts:466`), never logged, socket 0600 POSIX | Windows socket ACL; in-memory token visible in `/proc/<pid>/environ` (normal) |
| MCP secrets | SecretStorage; `secret:<key>` refs; in-memory namespace, fail-closed | Nothing |
| Memory writes | `SecretRefusedError` on 15 secret patterns — verified real | Patterns incomplete (H4); no redaction on read/injection |
| Tool-output redaction | `redactSecrets` + `<untrusted_tool_output>` delimiters + injection guard | User-path coverage (C1); pattern gaps (H4) |
| Credential ask-gate | **Dead code** — nothing | Wire up or remove (H1) |
| Gateway prompt storage | Never stored — forwarded only (token counts only) | Document upstream providers' policies (M-doc) |
| Gateway token logging | None in code; constant-time compare; XFF not trusted | Label in audit lines (M1); plaintext cache keys (M2) |
| Browser screenshots | Never written to disk; not sent to provider (metadata dropped) | Password values in snapshots (H2); recording perms (M5); takeover observation (M8) |
| Browser isolation | Own profile, never touches user's real Chrome; file:// + private ranges blocked | DNS rebinding (M9); profile perms (M5) |
| Landing page | Zero trackers, zero third-party scripts, no forms | Nothing (keep clean) |
| Retention | Nothing — no TTL/purge/delete anywhere | Retention policy + session-delete RPC (M7) |
| Webview CDN | — | Repoint off Microsoft CDN (H7) |
| Relay | Fails over across providers | Re-consent / opt-out (M6) |

---

## 4. Actionable Recommendations (prioritized)

### P0 — Do before any public launch with real users

1. **Close the user-path exfil gap (C1).** Route all outbound prompt content through `redactSecrets`: `composeChatMessage` (`ext-agent/src/chatView.ts`), `buildEditPrompt`, `buildFixPrompt`/`buildExplainPrompt`/`buildTestsPrompt`, `buildTerminalErrorPrompt`, `buildCommitPrompt`, `CompletionOrchestrator.run`. One pre-send filter, extension-side + loop-side.
2. **Expand `SECRET_PATTERNS`** (`packages/skills/src/memory.ts:54-69`): add `sk-or-v1-`, `gsk_`, JWT shape, generic high-entropy `KEY=value` catch-all, `postgres://`/`mongodb://` connection strings. Test against real `.env` samples (H4).
3. **Wire up or delete credential-gate (H1).** Either call `credentialGateReason` in `read_file`'s execute path + a confirm dialog in `ext-agent/src/mentions.ts:expandFile` for credential files — or delete `credential-gate.ts`/`taint.ts` and stop claiming the control in docs.
4. **Redact password-type input values at snapshot time (H2).** In `playwright-driver.ts` `SNAPSHOT_SCRIPT`: skip `.value` for `type=password`, `autocomplete` containing `password`, credit-card fields.
5. **chmod the secret-bearing stores (H3, H6, M4, M5).** `checkpoints.ts:ensureShadowRepo` → mkdir `0o700` + chmod tree; `orchestrator/src/state.ts` → mkdir `0o700`, writeFile `0o600`; `context/src/indexer.ts` → `0o600`/`0o700` + built-in credential-filename skips independent of `.gitignore`; `browserd/src/server.ts` media dirs → `0o700`.

### P1 — Do within weeks of launch

6. **Stop logging PII in gateway audit lines (M1).** `keyId` = namespaced key only (`gh:<id>`); fix the `audit.ts` docstring; keep label in the in-memory cache only.
7. **Hash OAuth cache keys (M2).** `SocialVerifier`: key by `SHA-256(token)` so plaintext tokens never rest in memory.
8. **Revoke refresh tokens on sign-out (M3).** In `sunday-google-auth` `removeSession`: revoke the refresh token too (Google invalidates dependent access tokens); surface revocation failure.
9. **Repoint webviews off Microsoft's CDN (H7).** `vscode/product.json` `webviewContentExternalBaseUrlTemplate` → Sunday-controlled hosting or self-hosted assets.
10. **Retention + deletion (M7).** Add `session/delete` RPC; configurable TTL sweep for sessions, orchestrations, browser-sessions, checkpoint pruning (keep N latest per workspace). Document in PRIVACY.md.
11. **Relay consent (M6).** Surface failover target; let users opt out per provider or at least log destination provider id; never silently move a conversation between vendors.

### P2 — Harden as you scale

12. **Pause observation on browser takeover (M8).** Stop screencast + recording in `takeover()`; resume on release.
13. **DNS validation at navigation time (M9)** or document as accepted residual risk in THREAT_MODEL.md.
14. **Windows IPC parity (M10).** Replace POSIX-only socket chmod with equivalent ACL restriction, or document reliance on profile ACLs.
15. **Reduce Google scopes (M12)** to `openid email`; reassess `access_type=offline` need; make scope-merging explicit in UX.
16. **Publish a privacy policy + DEPLOY.md retention section (M-doc).** What the audit log contains (IP, email/UPN today), where it goes (platform log drain), that prompts go to OpenRouter/Groq under their policies, memory-only server storage, no-retention-today disclosure.
17. **Packet-capture verification** (telemetry auditor's caveat): confirm at runtime that no telemetry/update/crash traffic leaves the IDE.
18. **Hide dead telemetry settings** in Settings UI (M13); fix gallery description text.

---

## 5. Positive findings (keep these)

- Telemetry/update/crash-reporting fully inert in the fork — genuinely clean.
- Landing page: zero trackers, zero third-party scripts, no data collection.
- Sessions/background/socket at 0600/0700; env-only BYOK; SecretStorage for MCP secrets; in-memory-only OAuth token and MCP secret namespaces.
- Memory write-time secret refusal is real and tested.
- Tool-output redaction + untrusted delimiters + injection guard is a real choke point for the agent loop.
- Gateway never stores prompts/responses; tokens never logged; constant-time auth compare; XFF deliberately not trusted; tool execution structurally excluded from the hosted surface.
- Browser screenshots never leave the machine (metadata dropped before provider request); profile isolated from the user's real Chrome.
- Open VSX gallery (not Microsoft); machine-ID headers gated on telemetry → not sent.

---

*Report compiled from 5 parallel code-read audits. All file citations refer to `~/workspace/sunday-product`. No code was modified during the audit.*
