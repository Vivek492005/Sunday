# Sunday — Technical Deep-Dive Research Notes

**Purpose:** Research notes for a document writer. Precise technical details with
file paths and commit hashes. Not the final user-facing document.
**Date:** 2026-10-09 | **HEAD:** `f1307b47` | **Repo:** `Vivek492005/Sunday`

---

## 1. `packages/ext-agent/` — The VS Code Extension (VSIX)

**Identity** (`packages/ext-agent/package.json`):
- `name`: `sunday-agent` | `publisher`: `sunday` | `displayName`: "Sunday Agent"
- `version`: `1.0.0-beta.2` (note: repo HEAD is past beta.2; version bump pending)
- `main`: `./dist/extension.cjs` — bundled with esbuild into a single CJS file
- `engines.vscode`: `^1.140.0` (matches the vendored fork)
- `activationEvents`: `["onStartupFinished"]`
- Workspace deps: `@sunday/context`, `@sunday/mcp`, `@sunday/protocol`, `@sunday/tools`

**Entry point** (`packages/ext-agent/src/extension.ts`):
- `activate()` owns: sundayd sidecar lifecycle (`SidecarManager`), typed
  `HostBridge`, status-bar health, command registration, Sunday Chat webview.
- Extension ID constant: `sunday.sunday-agent`
- Defensive hardening commit `3ca80ecb`: try/catch around streak + GitHub
  command registration so activation can never throw (was a black-screen suspect,
  later exonerated — the real cause was `product.json`, see §4).

**`src/` module map (top level, ~90 files; `*.test.ts` mirrors each module):**

| Module(s) | Responsibility |
|---|---|
| `extension.ts` | Activation entry, sidecar lifecycle, command registration |
| `sidecar.ts` (`SidecarManager`) | Discovers/spawns the `sundayd` binary as a child process, handshake, restart |
| `hostBridge.ts` | Typed RPC bridge between extension host and sundayd |
| `daemon-connector.ts` | Connection management to the daemon |
| `chatView.ts` / `managerView.ts` | Chat webview + Agent Manager webview providers |
| `mcpView.ts`, `browserPanel.ts` | MCP servers panel, browser-agent panel |
| `inlineCompletion.ts`, `inlineEdit.ts`, `nextEdit.ts` | Editor intelligence: completions, inline edit, next-edit suggestions |
| `codeActions.ts`, `gitCommit.ts`, `terminalExplain.ts` | Code actions, AI commit messages, terminal error explainer |
| `agentSend.ts`, `orchestrationCommands.ts` | Agent dispatch + parallel-agent orchestration commands |
| `swarmWebview.ts`, `mission-control/` | Swarm UI, mission-control dashboard |
| `memoryPanel.ts`, `memoryApply.ts`, `modes.ts` | Memory UI, cross-project memory, agent modes |
| `agentsMd.ts`, `styleInfer.ts`, `templates/` | AGENTS.md awareness, style inference, prompt templates |
| `proactiveMode.ts`, `scheduler.ts`, `cloudTasks.ts` | Proactive suggestions, cron scheduling, cloud offload |
| `bestOfNView.ts`, `artifacts/` | Best-of-N candidate picker, artifacts panel |
| `design-to-code.ts`, `onboarding/` | Mockup→code, repo onboarding |
| `engagement/` | Streaks/gamification (see §5) |
| `entitlements/` | Plan gating: `entitlementsCache.ts`, `provider.ts`, `browserGating.ts` |
| `update/` | `updateService.ts` + `installer.ts` (auto-update, see §7) |
| `accountView.ts`, `adminPlan.ts` | Account status bar, admin plan UI |
| `githubRepos.ts` | One-click repo import (`sunday.github.cloneRepo`) |
| `usage/` | Usage dashboard + `gatewayClient.ts` |
| `sync.ts` | E2E session sync |
| `secretResolver.ts`, `trust.ts` | Secrets → env, workspace trust prompts |
| `skills-marketplace/` | Skills marketplace panel |
| `rpc.ts`, `prompt-redaction.ts` | RPC plumbing, prompt PII redaction |

**Webview UIs** (separate packages, bundled into the VSIX):
- `@sunday/ui-chat` (v1.0.0-beta.2) — chat webview (`packages/ui-chat/`)
- `@sunday/ui-manager` (v1.0.0-beta.2) — manager webview (`packages/ui-manager/`)

---

## 2. `packages/hosted-gateway/` — The Hosted AI Gateway (Render)

**Identity** (`packages/hosted-gateway/package.json`):
- `name`: `@sunday/hosted-gateway` (private) | `version`: `1.0.0-beta.2`
- `main`: `dist/index.js` | `bin`: `sunday-hosted-gateway` → `dist/cli.js`
- Deps: `@sunday/gateway`, `@sunday/protocol` (workspace)
- Deployed: `https://sunday-final-ide.onrender.com` (Render, Docker;
  `packages/hosted-gateway/Dockerfile`). Hardcoded as `DEFAULT_GATEWAY_URL` in
  ext-agent (`cloudTasks.ts`, `extension.ts:915`, `entitlementsCache.ts`,
  `usage/gatewayClient.ts`).

**Architecture:** single-file router in `src/server.ts` (~900 lines, no
Express — raw `node:http` with manual `method + path` dispatch). Each domain
lives in its own module (`auth.ts`, `quota.ts`, `updates.ts`, …) with
co-located `*.test.ts`.

**Complete endpoint list** (from `src/server.ts`):

| Method | Path | Module | Notes |
|---|---|---|---|
| GET | `/health` | server.ts | Public; skips auth |
| POST | `/auth/session` | auth.ts | Google/MS token → Sunday session JWT; accepts `machine_id` (account-switch limit) |
| POST | `/auth/refresh` | auth.ts | Session refresh |
| POST | `/auth/logout` | auth.ts | Session revoke |
| GET | `/me/entitlements` | entitlements.ts | Plan-derived entitlement keys |
| GET | `/me/usage` | usage.ts | Usage history |
| GET | `/me/usage/today` | usage.ts | Today's consumption |
| POST | `/sync/sessions` | sync.ts | Upload E2E agent sessions |
| GET | `/sync/sessions` | sync.ts | Download sessions |
| GET | `/updates/check` | updates.ts | Public, per-IP rate-limited (see §7) |
| POST | `/v1/chat/completions` | openai-api.ts | OpenAI-compatible inference; routes via `Router` |
| GET | `/v1/models` | openai-api.ts | Model list |
| POST | `/admin/login` | admin-auth.ts | Allowlist (`SUNDAY_ADMIN_EMAILS`), 5 attempts/min/IP |
| POST | `/admin/logout` | admin-auth.ts | — |
| POST | `/admin/refresh` | admin-auth.ts | Refresh-token rotation |
| GET | `/admin/me` | admin-auth.ts | Admin JWT (`iss: sunday-admin`, role `admin`, 8h) |
| POST | `/admin/signin-log/clear` | auth.ts | Support tool (admin key) |

**Auth model:**
- Users: OAuth (Google/Microsoft) → `POST /auth/session` → Sunday session JWT.
  Google sign-in works even if gateway is down (Google-only fallback mode).
- Admin: separate issuer/role, email-allowlist, fail-closed when unset.
  Admin bypasses account-switch + managed quota limits (not webhook signatures).

**Abuse controls** (commit `059ca326`):
- `signin_log.json` tracks `{machineId, provider, sub, userId, at}` (Render-local
  JSON — **not durable across redeploys; needs Postgres for production**).
- Max 2 distinct accounts per provider per machine per 24h; 429
  `account_switch_limit` on denial; paid plans bypass; re-login always allowed.

**Providers** (`packages/gateway/src/providers.ts`, `registry.ts`):
- `openrouter` → `https://openrouter.ai/api/v1`
- `groq` → `https://api.groq.com/openai/v1`
- Also registered in the provider union: `sunday` (own), `ollama` (local fallback).
- Default route (`server.ts:146-147`): `openrouter:meta-llama/llama-3.3-70b-instruct`.
- Server holds provider keys; clients never see them. BYOK also supported.

**Quota** (`quota.ts`, `streakBonus.ts`, `rate-limit.ts`, `ip-rate-limit.ts`):
- Metering separates `base` and `streak_bonus`.
- Streak tiers: 7d → +100/day, 14d → +200/day, 30d → +500/day.
- **v1 trusts client-provided streak** via `X-Sunday-Streak-Days` header
  (sanitized: 0–3650); signed activity attestations are a documented future task.

---

## 3. `packages/sundayd/` & `packages/browserd/` — The Daemons

### sundayd — the agent sidecar daemon
- `name`: `@sunday/sundayd` | `bin`: `sundayd` → `dist/cli.js`
- Deps: `@sunday/browserd`, `@sunday/context`, `@sunday/gateway`, `@sunday/mcp`,
  `@sunday/orchestrator`, `@sunday/protocol`, `@sunday/skills`, `@sunday/tools`, `zod`
- **What it is:** the agent runtime. Spawned as a child process by the extension's
  `SidecarManager`; executes agent loops, tools, orchestration, scheduling.
- **Key modules** (`src/`, ~35 files): `daemon.ts` (lifecycle), `loop.ts`
  (agent loop + security), `manager.ts`, `sessions.ts`, `task-runner.ts`,
  `scheduler.ts` (cron), `orchestration-lifecycle.ts`, `agent-tools.ts`,
  `browser-tools.ts` / `browserd.ts` (browserd child manager), `mcp-methods.ts`,
  `workspace-*.ts` (trust, secrets, MCP), `sandbox.ts`, `taint.ts`
  (taint tracking), `credential-gate.ts`, `checkpoints.ts`, `worktrees.ts`,
  `proactive.ts`, `system-prompt.ts`, `completion.ts`.
- **Protocol:** **NDJSON-over-stdio JSON-RPC** (`transport.ts` →
  `StdioTransport`; codec shared in `rpc-transport.ts`):
  one JSON object per `\n`-terminated line on stdin; responses/notifications on
  stdout; diagnostics on stderr (never corrupts the frame stream).
  Also supports the **same NDJSON framing over `node:net` sockets**
  (unix sockets / Windows named pipes) via `SocketServerTransport` —
  "only the byte source/sink differs" (`rpc-transport.ts` header).
- Shared message types live in `@sunday/protocol` (`jsonrpc.ts`, `daemon.ts`,
  `handshake.ts`, `chat.ts`, `orchestrate.ts`, `scheduler.ts`, `browser.ts`, …).
- Boot token: `DAEMON_BOOT_TOKEN_ENV` from `@sunday/protocol`.

### browserd — the browser automation daemon
- Child of sundayd (spawns lazily on first `browser_*` tool use).
- **Protocol:** same NDJSON-over-stdio JSON-RPC contract (`transport.ts` →
  `BrowserTransport`); speaks only `browser/*` methods.
- **Driver:** Playwright (`playwright-driver.ts`); `fake-driver.ts` for tests.
- **Policy:** `policy.ts` — restricted page eval (§18.2, `allowEval` default
  false → `browser/eval` denied); password redaction (`password-redaction.ts`).
- Methods defined in `@sunday/protocol` (`BROWSER_METHODS`, `browser.ts`).

### Packaging note
`scripts/package-vsix.mjs` bundles both sidecars into the VSIX via esbuild
(cross-platform); `scripts/sync-builtin.sh` stages the built VSIX as a
built-in extension under `vscode/extensions/sunday-agent/` for the fork build.

---

## 4. `vscode/` Fork — What Changed vs Stock VS Code

Vendored VS Code **1.140.0** source (~19k files). `vscode/src/` has **zero**
Sunday changes — all deltas are config, branding, and two built-in extensions.

**`vscode/product.json` (branding + behavior):**
| Key | Value | Notes |
|---|---|---|
| `nameShort` / `nameLong` | `Sunday` | — |
| `applicationName` | `sunday` | — |
| `dataFolderName` | `.sunday` | (vs `.vscode`) |
| `urlProtocol` | `sunday` | OS URL handler |
| `win32AppUserModelId` | `Sunday.Sunday` | — |
| `darwinBundleIdentifier` | `com.sunday.sunday` | — |
| `extensionsGallery.serviceUrl` | `https://open-vsx.org/vscode/gallery` | **Open VSX**, not Microsoft Marketplace (commit `79fb99f7`) |
| `defaultChatAgent` | → `sunday.sunday-agent` | **Load-bearing.** Deleted by `dd29d944` → black screen (workbench dereferences it unguarded at `defaultAccount.ts:158`). Restored by `c6417571`, repointed from `GitHub.copilot` to Sunday's own extension. |
| `trustedExtensionAuthAccess.github` | `[]` | Copilot refs emptied (`8291c957`) — safe |

**Icons:** `vscode/resources/` — Sunday logo ICO/ICNS/PNG replaced stock
(`c2ec2a8b`).

**Built-in extensions:**
1. `vscode/extensions/sunday-agent/` — staged from the built VSIX by
   `scripts/sync-builtin.sh` during CI (picked up automatically by
   `vscode/build/lib/extensions.ts` globbing `extensions/*/package.json`).
2. `vscode/extensions/sunday-google-auth/` (`name: sunday-google-auth`,
   `main: ./dist/extension.js`) — Sunday's Google auth provider extension,
   added `ef386522`; implements `vscode.AuthenticationProvider`, exchanges
   Google tokens for Sunday gateway sessions (`session.ts`), sends
   `vscode.env.machineId` for account-switch limiting (`059ca326`).

**OAuth:** Google client ID baked in as default (`4ea67042`, `b01a6877`).

---

## 5. Engagement System — How Streak Tracking Works Technically

**Location:** `packages/ext-agent/src/engagement/`
(`activity.ts`, `streak.ts`, `mode.ts`, `streakBonusTiers.ts`, `streakView.ts`,
`index.ts`; each with `*.test.ts`).

**Design rule:** reward *shipped work*, not app opens. Two modes:
- **Passive** (editing/reading only): silent streak tracking + status bar `🔥 N`;
  no quest prompts/XP popups. Limited milestone + at-risk notifications allowed.
- **Active** (first AI-agent use in session): full quests/XP/achievements UI.
- Setting: `sunday.engagement.quietMode` (`auto` | `passive` | `active`).

**Activity detection** (`activity.ts`):
- Records MEANINGFUL actions only: git commits, active editing minutes, merged
  PRs, completed AI tasks, test runs. Bare app opens never count.
- A day qualifies as a "streak day" if: ≥1 commit **OR** ≥30 min active editing
  (`STREAK_DAY_EDIT_MINUTES = 30`) **OR** ≥1 merged PR **OR** ≥1 AI task
  (see `isStreakDay()`).
- Edit sessions: keystrokes within `EDIT_SESSION_GAP_MS` (5 min) count as
  continuous active editing.
- Day keys are **local-timezone** `YYYY-MM-DD` (`localDayKey()`) — streaks
  follow the user's clock.
- Retention: 400 days (`ACTIVITY_RETAIN_DAYS`), pruned opportunistically.

**Streak engine** (`streak.ts` — pure logic, zero `vscode` dependency):
- Constants: `FREEZE_EARN_EVERY_DAYS = 7`, `MAX_FREEZES = 3`,
  `VACATION_MAX_DAYS_PER_YEAR = 14`, `STREAK_AT_RISK_MIN_DAYS = 3`,
  `STREAK_AT_RISK_HOUR = 18` (at-risk nudge eligible: streak ≥3, no activity
  today, after 6 PM local).
- **Streak Freeze:** earn 1 per 7 streak days (max 3 stored); a single missed
  day auto-consumes a freeze instead of breaking the streak.
- **Vacation Mode:** pause up to 14 days/year.
- Milestone tiers mirrored with gateway: `[7, 14, 30]`.

**Storage (local JSON, mode `0600`):**
- `~/.sunday/engagement/activity.json` — per-day activity counters
- `~/.sunday/engagement/streak.json` — `StreakState`
  (`current`, `longest`, `lastActiveDate`, `freezesAvailable`,
  `freezeMilestone`, `vacationDaysUsed/Year/Start/Until`,
  `lastRiskNotifiedDate`, `lastMilestoneNotifiedAt`)
- All time injectable for tests.

**Gateway bonus flow** (commit `94423919`):
- ext-agent sends `X-Sunday-Streak-Days` header on managed requests.
- Gateway `streakBonus.ts` maps 7/14/30 → +100/+200/+500 req/day, stacked on
  the plan's base quota; quota metering splits `base` vs `streak_bonus`.
- Client mirror of tiers: `streakBonusTiers.ts` (must stay in sync).

**Registration hardening** (`3ca80ecb`): streak + GitHub command registration
wrapped so a failure can never abort extension activation.

---

## 6. Payment Architecture — Paddle Plan (from `docs/PAYMENT_ARCHITECTURE.md`)

> ⚠️ The doc is titled "Cashfree (India)" v1.0, dated 2026-10-08, status
> **Design (not implemented)**. The user has since decided **Paddle** (Merchant
> of Record, handles GST globally) — the doc needs a Paddle rewrite at
> implementation time. Tier/limit numbers below are provider-agnostic and
> already reflected in `entitlements.ts`.

**Tiers** (`recomputeEntitlements()` table, `docs/PAYMENT_ARCHITECTURE.md:166-173`):

| Tier | Price (INR/mo) | Requests/day | Agents | Parallel | Browser/day | Index MB | Support |
|---|---|---|---|---|---|---|---|
| free | 0 | 200 | 1 | no | 0 | — | — |
| basic | 149 | 500 | 2 | no | 5 | 500 | email |
| smart | 349 | 1,200 | 3 | no | 15 | 2,000 | email |
| pro | 799 | 3,000 | 4 | **yes** | unlimited (-1) | 5,000 | priority |

**Architecture principles** (doc §1): never touch money credentials (hosted
pages only, zero PCI scope); idempotency everywhere (webhooks safe to retry);
entitlements derived from subscription record via single
`recomputeEntitlements(userId)` writer; graceful degradation (payment outage
never breaks the IDE); immutable audit log; provider-agnostic core.

**Flow** (doc §2): IDE "Upgrade" → gateway `POST /billing/checkout` → payment
service creates order/subscription via provider API → checkout URL opened
externally → user pays on hosted page (UPI/Card + AutoPay mandate) → webhook
(HMAC-verified, idempotency-checked) → update subscription → recompute
entitlements → GST invoice → audit log → IDE refreshes entitlements.

**Entitlement model** (`packages/hosted-gateway/src/entitlements.ts`):
`PlanId = 'basic' | 'smart' | 'pro'` (+ free default). Code checks
*entitlement keys*, never raw plan ids. `plans.json` schema-validated
(must include `basic`).

---

## 7. Auto-Update Mechanism

**Two halves: gateway check + IDE installer.**

**Gateway** (`packages/hosted-gateway/src/updates.ts`):
- `GET /updates/check?platform=win32|darwin|linux&current=1.0.0` — public
  (works signed-out), per-IP rate-limited.
- Reads GitHub releases API (10-min cache, 10s fetch timeout); failures return
  `updateAvailable: false` + generic `error` hint (never leaks upstream text).
- **Beta channel** (commit `20669ffa`): beta installs query `/releases` list
  (not `/releases/latest`, which ignores prereleases); stable installs are
  never offered betas. `normalizeTag()` maps `ide-v1.0.0-beta.N` → `1.0.0-beta.N`
  for semver comparison. Custom `compareVersions()` handles prereleases.
- Asset matching (`findPlatformAsset`): win32 → name contains `win` + `.exe`;
  darwin → `mac` + `.dmg`; linux → `linux` + `.tar.gz`. **UserSetup uploaded
  first** so the updater picks the per-user installer (no admin rights).

**IDE** (`packages/ext-agent/src/update/`):
- `UpdateService` (`updateService.ts`): builds
  `{gatewayUrl}/updates/check?platform&current`, validates response shape,
  silent auto-check (no UI when up-to-date/unreachable) + manual
  `sunday.checkForUpdates` command (always reports). Status-bar entry
  (`extension.ts:982`) triggers it.
- `installer.ts` (`UpdateInstaller`): downloads the asset and hands off to the
  OS installer.
- Gateway URL resolves to `https://sunday-final-ide.onrender.com` by default
  (`extension.ts:915`).

**Release process:** manual (CI auto-upload disabled, `3755b9f9`, after
duplicate-asset incidents). Tag `ide-v1.0.0-beta.N` → full `sunday-ide.yml`
build (~40 min, 9 jobs: win/mac/linux + lint/typecheck/coverage/secret-scan/
advisory-scan/prepare-release) → artifacts downloaded → 5 assets uploaded
with canonical names (`Sunday-UserSetup-…-win-x64.exe` first).

---

## Appendix: Key Commits Referenced

| Hash | Description |
|---|---|
| `81c32c25` | Beta.1 (working baseline) |
| `dd29d944` | Removed `defaultChatAgent` → black-screen root cause |
| `c6417571` | Restored `defaultChatAgent` → `sunday.sunday-agent` (fix) |
| `3ca80ecb` | Extension activation hardening |
| `26833d89` / `94423919` | Streaks + streak quota header |
| `b432119c` | Admin gateway |
| `059ca326` | Account-switch rate limiting |
| `20669ffa` | Auto-update beta channel |
| `3755b9f9` | Disabled CI auto-upload of release assets |
| `9957a85f` | `skip_extension` CI diagnostic flag |
| `7d388bab` | One-click repo import |
| `a44572d5` | Sunday session issuance |
| `79fb99f7` | Open VSX gallery |
| `4ea67042` | Baked-in Google OAuth client ID |
