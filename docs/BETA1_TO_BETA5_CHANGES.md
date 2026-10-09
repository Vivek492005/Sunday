# Beta.1 → Beta.5: Change Analysis & Integration Plan

**Range:** `81c32c25` (Beta.1, working) → `9957a85f` (current HEAD)
**Total commits:** 144
**Date of analysis:** 2026-10-09

---

## 1. Category Breakdown

| Category | Commits touching it | Notes |
|---|---|---|
| DOCS / LANDING | ~89 | Docs, plans, landing page, branding — zero runtime impact |
| EXTENSION (`packages/ext-agent/`) | 44 | The VSIX — runs in extension host (separate process) |
| GATEWAY (`packages/hosted-gateway/`) | 23 | Server side (Render) — no IDE impact |
| DAEMON (`packages/sundayd/`, `browserd/`) | 23 | Sidecar binaries — no workbench impact |
| **WORKBENCH (`vscode/`)** | **12** | **Fork config + built-in ext — BLACK SCREEN ZONE** |
| CI (`.github/`) | 11 | Build process |
| SCRIPTS / OTHER | ~50 | Tests, tooling, misc |

> Key insight: the workbench JS bundle (`vscode/src/`) has **zero** changes in this range.
> The packaged app differs from Beta.1 only in: `product.json`, `resources/` icons,
> `vscode/extensions/sunday-google-auth/` (new), and the bundled `sunday-agent` VSIX
> (exonerated by the Beta.4 no-extension test build, which was still black).

---

## 2. User-Facing Features Added Since Beta.1

### 🔥 Engagement / Gamification
- **Coding streaks** (`26833d89`) — streak tracking for meaningful actions (commits,
  30+ min active edits, merged PRs, successful AI tasks); status bar `🔥 N`;
  Streak Freeze (1 per 7 days, max 3); Vacation Mode (14 days/year);
  milestone progress + at-risk notifications
- **Streak bonus quota** (`94423919`) — sends `X-Sunday-Streak-Days` header;
  gateway bonus tiers: 7d → +100/day, 14d → +200/day, 30d → +500/day

### 🔐 Auth & Admin
- **Separate admin gateway** (`b432119c`) — `POST /admin/login|logout|refresh`,
  `GET /admin/me`; allowlist via `SUNDAY_ADMIN_EMAILS`; 8h sessions; audit logs
- **Account-switch protection** (`059ca326`) — max 2 distinct accounts per
  provider per machine per 24h (anti-Sybil); paid bypass
- **Sunday session issuance** (`a44572d5`) — Google sign-in exchanges token for
  Sunday gateway session; auto-refresh; Google-only fallback when gateway down
- **Account status bar UI** (`1347c587`) — Sunday account status bar shell
- **GitHub sign-in option** (`cec5c1b7`) — sign-in menu offers Google + GitHub
- **One-click repo import** (`7d388bab`) — `sunday.github.cloneRepo`

### 🔄 Auto-Update
- **Beta channel support** (`20669ffa`) — beta installs check `/releases` list
  (not `/releases/latest`); `normalizeTag()` maps `ide-v1.0.0-beta.N`;
  stable users never offered betas
- **Auto-update endpoint** (`974cf306`, `b4073212`, `42bbe055`) — gateway
  `GET /updates/check` with retry + rate-limit handling
- **IDE auto-update UI** (`a606d80a`) — check, notify, one-click install

### 🤖 Agent Features (extension)
- Mission-control dashboard (`623d17a2`), scheduler/cron tasks (`fe5e70e6`),
  personalization B1–B5 (AGENTS.md, style inference, templates, modes, memory
  learning — `0a7cbdbb`, `d8d4b0e7`, `6671eff0`, `2c978515`, `1b500608`),
  artifacts panel (`739481d5`), best-of-n (`551ee599`), cloud tasks (`bef743e5`),
  E2E session sync (`7a6b0411`, `4b56866d`), usage dashboard (`a13c88bd`,
  `297fdbfa`), entitlements (`72f72a18`, `f089d55f`, `094755d2`),
  swarm/orchestrator (`17006d9f`), proactive mode (`0e4824fb`),
  learning loop (`ed144a25`), Second Brain (`1e925edb`),
  repo onboarding (`5ea296be`), design-to-code (`6a05a0f7`),
  F1–F4 views (`9612b9d5`)
- **Zero-config AI** (`24cca38f`, `8d3249f3`) — hosted gateway, GitHub/Google/MS
  OAuth free tier (200 req/day)

### 🖥️ IDE / Workbench
- Open VSX as extension gallery (`79fb99f7`)
- Sunday logo app icons (`c2ec2a8b`)
- Google OAuth client ID baked in (`4ea67042`, `b01a6877`)
- Extension activation hardening (`3ca80ecb`) — defensive try/catch around
  streak + GitHub command registration

### 🔧 CI / Release Process
- `skip_extension` diagnostic flag (`9957a85f`)
- Disabled CI auto-upload of release assets — manual releases only (`3755b9f9`)
- Build-before-test, Windows path fixes, secret-scan exclusions

---

## 3. WORKBENCH Changes — Risk Assessment

Only 12 commits touch `vscode/`. Ranked by black-screen risk:

### 🔴 HIGH RISK

**`dd29d944` — "IDE: remove defaultChatAgent" (Oct 7)**
- File: `vscode/product.json` (69 deletions — entire `defaultChatAgent` block)
- **This is the black-screen root cause** (see §4).

**`ef386522` — added `vscode/extensions/sunday-google-auth/` (Oct 7)**
- New built-in extension compiled into the fork (package.json, extension.ts).
- Risk: a malformed new built-in extension can break packaging/startup.
- Assessment: package.json is valid; extension builds clean in CI.
  Downgraded to MEDIUM after root-cause confirmation — but worth a
  packaging sanity check in Beta.5 (verify `dist/extension.js` exists
  in the built artifact).

### 🟡 MEDIUM RISK

**`a44572d5` — Sunday session issuance (Phase 9.a)**
- `vscode/extensions/sunday-google-auth/`: new `session.ts`, `tsconfig.json`,
  `package-lock.json`; rewrote parts of `extension.ts`.
- Risk: auth-provider bugs surface at sign-in, not at window open. No
  startup path touched. LOW for black screen, MEDIUM for sign-in regressions.

**`1347c587` — Sunday Account status bar UI shell**
- Touches `sunday-google-auth` package.json + extension.ts.
- Status-bar contribution activates on window load. A throw in the
  status-bar provider could spam errors but not black-screen (extension host
  is a separate process). LOW for black screen.

**`8291c957` — "remove stale Copilot refs from product.json"**
- Emptied `trustedExtensionAuthAccess.github`, `builtInExtensionsEnabledWithAutoUpdates`,
  set `voiceWsUrl: ""`.
- Risk: empty arrays / empty string are valid values; no unguarded
  dereference found for these keys. LOW.

**`79fb99f7` — Open VSX gallery config**
- Rewrote `product.json` (tabs→spaces) + gallery URLs.
- Content-equivalent; valid JSON. LOW.

### 🟢 LOW RISK

| Commit | Change | Why safe |
|---|---|---|
| `5c4835db` | Removed broken copilot `.sqlite` test cache files | Deletions of test fixtures only |
| `c2ec2a8b` | Sunday logo icons (ico/icns/png) | Binary assets; installer picks them up, no code path |
| `cd9f4524` | Revoke refresh token on Google sign-out | Sign-out flow only |
| `4ea67042` / `b01a6877` | Google OAuth client ID updates | String constant changes |
| `059ca326` | Account-switch: `vscode.env.machineId` passed in sign-in flow | Sign-in flow only; guarded by server response |

---

## 4. Root Cause: The Black Screen

### The crash chain

1. **Commit `dd29d944`** (Oct 7, 07:16 UTC) deleted the entire `defaultChatAgent`
   block (69 lines) from `vscode/product.json`, intending to "disable Copilot setup".

2. In `vscode` 1.140.0 source, `defaultChatAgent` is declared **non-optional**:
   `src/vs/base/common/product.ts:276` → `readonly defaultChatAgent: IDefaultChatAgent;`
   (`product.json` is not type-checked against this interface at build time,
   so the removal compiled cleanly.)

3. At workbench startup, the **accounts service** runs unguarded:
   `src/vs/workbench/services/accounts/browser/defaultAccount.ts:158`
   ```ts
   this.defaultAccountConfig = toDefaultAccountConfig(productService.defaultChatAgent);
   //                                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ undefined
   ```
   and `toDefaultAccountConfig` immediately dereferences it:
   ```ts
   preferredExtensions: [defaultChatAgent.chatExtensionId, ...]  // 💥 TypeError
   ```

4. The throw happens during core workbench service instantiation →
   the renderer never finishes composing the window → **persistent black screen**.

### Confirming evidence

- ✅ Beta.1 rebuild (`81c32c25`, has `defaultChatAgent`) **opens** on the user's PC.
- ✅ Beta.2/3 (`a8832d67`, `3ca80ecb`) **black** — both lack the block.
- ✅ Beta.4 (`9957a85f`, `skip_extension=true`, **no sunday-agent bundled at all**)
  **still black** — exonerates `packages/ext-agent` completely; the fault is in
  fork config, i.e. `product.json`.
- ✅ Other unguarded dereferences exist too (`chatWidget.ts:1638-1639`,
  `agentSessionsWelcome.ts:754-755`), but `defaultAccount.ts` runs first at startup.
- ✅ `git log` confirms no `vscode/src/` changes in range — the workbench bundle
  is byte-identical; only its **configuration** changed.

### Why the earlier "extension hardening" (`3ca80ecb`) couldn't fix it

That commit wrapped the *sunday-agent* extension's activation in try/catch.
But the crash is in the **workbench's own accounts service**, before/without any
involvement of our extension. The extension host is a separate process — it
cannot black-screen the main window.

---

## 5. Beta.5 Integration Plan (cross-verified)

Goal: one rebuild containing **all** §2 features on top of a **working** Beta.1
base, with the root cause fixed and guarded against recurrence.

### Step 1 — The fix (required, ~5 min)

Restore the `defaultChatAgent` block in `vscode/product.json`, taken verbatim
from Beta.1 (`git show 81c32c25:vscode/product.json`), **but repointed at Sunday**:

```json
"defaultChatAgent": {
  "extensionId": "sunday.sunday-agent",
  "chatExtensionId": "sunday.sunday-agent",
  ... (keep the provider/URL structure from Beta.1 so every
       dereference in defaultAccount.ts, chatWidget.ts,
       agentSessionsWelcome.ts resolves)
}
```

Rationale: the type is non-optional and several workbench files dereference it
without guards. Keeping the block (pointed at our own extension) satisfies the
type contract AND advertises Sunday as the chat provider. Deleting it again
will reintroduce the black screen — treat this block as load-bearing.

> Alternative considered: patch the fork source (`defaultAccount.ts` etc.) with
> `?.` guards. Rejected — touching vendored `vscode/src/` increases future
> merge burden; the config-level fix is smaller and matches how the product is
> meant to be configured.

### Step 2 — Verify no other load-bearing deletions (15 min)

- [ ] Diff `vscode/product.json` Beta.1 ↔ HEAD key-by-key (ignoring whitespace);
      every removed key gets a `grep` in `vscode/src` for unguarded use.
- [ ] Confirm `trustedExtensionAuthAccess`, `builtInExtensionsEnabledWithAutoUpdates`,
      `voiceWsUrl` removals (from `8291c957`) are safe — done in this analysis: safe.
- [ ] Verify `vscode/extensions/sunday-google-auth/dist/extension.js` is produced
      by the fork build (check CI build log for the extension compile step).

### Step 3 — Keep everything else as-is

All §2 features (streaks, admin gateway, account-switch, auto-update beta
channel, GitHub import, agent features, daemon, gateway) live in
`packages/*` and are **orthogonal** to this fix. No feature needs to be reverted.

### Step 4 — Rebuild & release Beta.5 (~50 min)

1. Commit the `product.json` fix → push to `main`.
2. Trigger `sunday-ide` workflow (full build, **with** extension bundling —
   do NOT use `skip_extension`; Beta.4 already proved the extension is innocent).
3. Create `ide-v1.0.0-beta.5` prerelease; upload the 5 standard assets
   (manual upload — CI auto-upload stays disabled per `3755b9f9`).
4. User installs `Sunday-UserSetup-1.0.0-beta.5-win-x64.exe` on Windows and
   confirms the main window opens.

### Step 5 — Regression guard (follow-up, not blocking Beta.5)

Add a CI check (or a `scripts/` linter) that asserts `vscode/product.json`
contains the load-bearing keys (`defaultChatAgent`, `nameShort`,
`applicationName`, `dataFolderName`, …) so a future "cleanup" commit can't
silently delete them again.

---

## 6. Files changed by the fix

| File | Change |
|---|---|
| `vscode/product.json` | Restore `defaultChatAgent` block (repointed to `sunday.sunday-agent`) |

That's it — a single config file. Everything else from the 144 commits rides along untouched.
