# Phase 4 Services Audit — Sunday Sign-in & Services

**Date:** 2026-10-12
**Scope:** `packages/ext-agent/src/`, `vscode/extensions/sunday-google-auth/`
**Type:** Audit only — no behavior changes made.

---

## 1. Google Sign-in Flow

### How it works (end-to-end trace)

```
User clicks status bar "Sunday Account" (accountView.ts:239 registerAccountStatusBar)
  → showMenu() → signed out → showLoginModal() (loginModal.ts:88)
  → centered webview with Google/GitHub buttons
  → user clicks "Continue with Google"
  → webview posts {type:'signin', provider:'google'}
  → signIn('google') (accountView.ts:276)
  → vscode.authentication.getSession('google', scopes, {createIfNone:true}) (accountView.ts:197)
  → VS Code routes to sunday-google-auth provider
  → GoogleAuthProvider.createSession() (sunday-google-auth/src/extension.ts:140)
  → loopbackFlow(): PKCE + local HTTP server on 127.0.0.1:random (extension.ts:253)
  → vscode.env.openExternal(Google OAuth URL)
  → user approves in browser → redirect to 127.0.0.1:port/callback?code=...
  → exchangeCode() → access_token + refresh_token (extension.ts:318)
  → fetchUserinfo() → sub, email, name (extension.ts:357)
  → store in SecretStorage (sunday.google.sessions)
  → sundaySession.establish(googleAccessToken, machineId) (extension.ts:170)
  → POST {gateway}/auth/session {google_access_token, machine_id}
  → Sunday session JWT + refresh token → SecretStorage (sunday.sessionToken, sunday.refreshToken, sunday.user)
  → onDidChangeSessions fires → accountView refresh() → status bar shows "☀ Sunday · email"
  → configureSundayHosted() passes OAuth token to sundayd (ext-agent extension.ts:222)
```

### Fragile points

| # | Issue | Severity | File:Line |
|---|-------|----------|------------|
| 1 | **Hardcoded OAuth client ID** (`110112861017-vceq10n...`). If this Google Cloud OAuth client is deleted, disabled, or hits quota, sign-in breaks for ALL users with no fallback. No health check. | P1 | sunday-google-auth/src/extension.ts:67 |
| 2 | **Loopback server on 127.0.0.1.** Corporate firewalls, VPNs, or proxies can block localhost listeners. No alternative flow (e.g. manual code paste). | P1 | sunday-google-auth/src/extension.ts:253-316 |
| 3 | **5-minute OAuth timeout.** If the user is slow (2FA, account chooser), the flow fails with a generic timeout error. No "still waiting, click to retry" UX. | P2 | sunday-google-auth/src/extension.ts:310 |
| 4 | **GitHub sign-in has no Sunday session.** `getSundaySessionInfo()` only queries the Google auth extension (accountView.ts:218-233). GitHub users get plan "Basic" default and no gateway JWT — their AI requests may silently lack auth. | P1 | ext-agent/src/accountView.ts:218 |
| 5 | **Sign-out depends on command presence.** Google sign-out goes through `sunday.google.signOut` command; if the auth extension is inactive, falls back to telling the user to use the Accounts menu. Acceptable but fragile. | P2 | ext-agent/src/accountView.ts:292-312 |
| 6 | **Token revocation is best-effort.** `fetch(...revoke...).catch(() => undefined)` — if revoke fails, the refresh token stays valid server-side after "sign out". (Code acknowledges this as Privacy M3.) | P2 | sunday-google-auth/src/extension.ts:198-207 |

### What's good
- Google sign-in succeeds even when the gateway is unreachable (local-first, Google-only mode). Excellent resilience design.
- PKCE (RFC 7636) correctly implemented for the loopback flow.
- Session refresh proactively refreshes tokens expiring within 5 min (extension.ts:110).
- `getSundaySession()` never throws — always degrades gracefully.

---

## 2. Gateway Connection

### How it works
- **Default URL:** `https://sunday-final-ide.onrender.com` — hardcoded in 3 places:
  - `packages/ext-agent/src/usage/gatewayClient.ts:14`
  - `vscode/extensions/sunday-google-auth/src/session.ts:28`
  - `packages/ext-agent/src/extension.ts:1014` (update service)
- **Precedence:** `sunday.gateway.url` setting → `SUNDAY_API_URL` env → hardcoded default.
- **Session ops timeout:** 10s (`GATEWAY_TIMEOUT_MS`, session.ts:146).
- **AI request path:** ext-agent passes the OAuth token to `sundayd` via `daemon/configure` RPC (extension.ts:222-262); the daemon makes the actual model calls.

### Fragile points

| # | Issue | Severity | File:Line |
|---|-------|----------|------------|
| 1 | **Render free tier cold starts.** Render free spins down after inactivity; first request can take 30-60s. The 10s session timeout (`GATEWAY_TIMEOUT_MS`) will fail on cold starts → user sees "gateway unreachable" even though it's just slow. No retry with backoff. | P1 | session.ts:146 |
| 2 | **Single hardcoded gateway, no fallback.** If onrender.com is down (or the service is deleted), ALL gateway features die: auth session, usage, entitlements, updates. No secondary URL. | P1 | 3 files (above) |
| 3 | **Gateway URL duplicated in 3 files.** If the URL changes, all 3 must be updated in sync. Should be a single shared constant. | P2 | gatewayClient.ts:14, session.ts:28, extension.ts:1014 |
| 4 | **No connection health check on startup.** The extension doesn't probe the gateway at activation; failures surface lazily when the user tries something. A startup ping could show "Sunday services unavailable" proactively. | P2 | — |

### What's good
- `GatewayUnreachableError` vs `GatewayAuthError` are properly distinguished — UI can show "check connection" vs "sign in again".
- Usage payload validation (`validateUsageSnapshot`) treats wire data as untrusted. Good.
- Entitlements degrade to 72h grace → fallback, never hard-fail.

---

## 3. Quota / Plans

### How it works
- **Server-authoritative:** The gateway rejects over-quota requests. Client cannot bypass.
- **Client approximation:** `entitlements/usage.ts` keeps a local daily counter (`sunday.managedModels.used.YYYY-MM-DD` in Memento) to grey out models in the picker without a network round-trip.
- **Entitlements:** `entitlementsCache.ts` fetches `GET /me/entitlements`, caches with `valid_until`, 72h grace window on failure, then Basic-equivalent fallback.
- **Entitlement keys** (types.ts:14-24): `managed_models.enabled`, `managed_models.daily_requests`, `orchestration.*`, `browser_agent.*`, etc. Client checks keys, never hard-codes plan names. Good design.

### Fragile points

| # | Issue | Severity | File:Line |
|---|-------|----------|------------|
| 1 | **`PlanId` type missing 'free'.** `type PlanId = 'basic' \| 'smart' \| 'pro'` (types.ts:26) but the Free tier (200 req/day) exists. If the gateway returns `plan: 'free'`, TypeScript type-checking may hide it but runtime code comparing plans could misbehave. Verify what the gateway actually returns for free users. | P1 | entitlements/types.ts:26 |
| 2 | **Local counter uses local timezone; server likely UTC.** At midnight local time, the client resets its counter but the server may not have (or vice versa) → models greyed out incorrectly for up to a few hours, or over-counting. | P2 | entitlements/usage.ts:24-29 |
| 3 | **Local counter is per-machine.** Memento is local; if the user hits quota on machine A, machine B doesn't know until the server rejects. Minor (server is authoritative). | P2 | entitlements/usage.ts |

### What's good
- Server-side enforcement means client bugs can't bypass limits.
- 72h grace window is generous for offline use.
- Entitlement-key abstraction (not plan-name checks) is the right pattern.

---

## 4. Auto-update

### How it works
```
Startup +30s (if sunday.update.checkOnStartup) or manual `sunday.checkForUpdates`
  → UpdateService.checkForUpdates() (updateService.ts:74)
  → GET {gateway}/updates/check?platform={platform}&current={version}
  → gateway auto-detects beta channel from version (1.0.0-beta.x → beta)
  → beta users get latest prerelease from /releases list; stable users never get betas
  → if updateAvailable: show "Download & Install" / "Release Notes" / "Later"
  → downloadAndInstall: fetch asset → tmpdir → platform installer → quit IDE
```

### Fragile points

| # | Issue | Severity | File:Line |
|---|-------|----------|------------|
| 1 | **Version source was wrong until today.** `currentVersion` comes from the extension's own `packageJSON.version` (extension.ts:97). The beta.3→beta.5 bump (commit b3f2b5f2, 2026-10-12) fixed this, but it proves version bumps are manual and error-prone. Recommend a CI check that `package.json` version matches the release tag. | P1 (fixed, needs guard) | extension.ts:97 |
| 2 | **No signature/hash verification on download.** The installer downloads the asset from `downloadUrl` and runs it. If the gateway is compromised (or DNS hijacked), arbitrary code execution. At minimum, verify a SHA256 hash from the gateway response. | P0 | update/installer.ts:40-50 |
| 3 | **Windows installer flow untested in this audit.** `installWindows()` spawns the installer and quits the IDE — needs real-machine verification (can't test on this Linux VM). | P1 | update/installer.ts |
| 4 | **Beta channel depends on gateway correctly parsing versions.** The gateway's `normalizeTag` maps `ide-v1.0.0-beta.5` → `1.0.0-beta.5`. If a future tag format changes, beta users stop getting updates silently. | P2 | hosted-gateway/src/server.ts:457 |

### What's good
- Beta/stable channel separation is well-designed and tested (30/30 gateway tests).
- Manual checks always report outcome; auto-checks stay silent. Good UX.
- Download validates non-empty file before installing.

---

## 5. Streaks

### How it works
- **Logic:** `engagement/streak.ts` — pure functions, Memento-backed. `refreshStreak()`, `setVacationMode()`, milestones, freezes, bonus tiers.
- **Panel:** `engagement/streakPanel.ts` — WebviewPanel with `ViewColumn.Beside`, module singleton with `onDidDispose` cleanup.
- **Bonus → gateway:** `x-sunday-streak-days` header sent with usage requests; server applies bonus quota.

### Fragile points

| # | Issue | Severity | File:Line |
|---|-------|----------|------------|
| 1 | **What counts as "activity" is unclear from this audit.** The streak increments on some activity signal — need to verify it's wired to real coding activity (not just IDE open). If it's only "IDE opened", streaks are meaningless. | P1 | engagement/streak.ts |
| 2 | **Streak state is local-only (Memento).** Reinstalling the IDE or switching machines resets the streak. Users will complain. Should sync to the gateway (tied to their Sunday account). | P1 | engagement/streak.ts |
| 3 | **Timezone edge:** Streak day boundaries use local time; a user coding at 11:55 PM might lose a day. Minor. | P2 | engagement/streak.ts |

### What's good
- Pure-logic + thin UI shell = well-tested (streak.test.ts exists).
- Panel singleton properly handles dispose/reveal.
- Vacation mode and freezes show thoughtful product design.

---

## Prioritized Fix List

### P0 (broken / security)
1. **Add hash verification to the auto-updater.** The installer executes a downloaded binary with no integrity check. (update/installer.ts)

### P1 (fragile — will break in real use)
1. **OAuth client ID health.** Monitor the Google Cloud OAuth client; add a startup check or at least document rotation procedure. (sunday-google-auth)
2. **Gateway cold-start retries.** Add retry with backoff for session ops, or raise timeout for the first request after idle. (session.ts:146)
3. **GitHub sign-in → no Sunday session.** Either wire GitHub through the gateway session exchange or clearly communicate the limitation. (accountView.ts:218)
4. **`PlanId` missing 'free'.** Verify gateway's actual plan value for free users; fix the type. (entitlements/types.ts:26)
5. **Streak sync.** Persist streaks server-side tied to the Sunday account. (engagement/streak.ts)
6. **Verify "activity" definition.** Confirm what increments the streak. (engagement/streak.ts)
7. **CI version-tag guard.** Fail CI if `ext-agent/package.json` version doesn't match the release tag being built. (workflow)
8. **Windows installer real-machine test.** Can't verify on Linux VM. (update/installer.ts)

### P2 (nice-to-have)
1. Loopback-blocked fallback for OAuth (manual code entry).
2. Single shared gateway URL constant (currently 3 copies).
3. Gateway startup health ping.
4. Local quota counter timezone alignment (use UTC like server).
5. Sign-out UX when auth extension inactive.
6. Token revocation failure surfacing.
7. OAuth 5-min timeout UX ("still waiting?").

---

## Sign-in Flow Diagram (for reference)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐     ┌──────────────┐
│ Status bar  │────▶│ Login modal  │────▶│ vscode.auth         │────▶│ sunday-google│
│ "Sunday     │     │ (webview)    │     │ .getSession         │     │ -auth ext    │
│  Account"   │     │ Google/GitHub│     │ createIfNone: true  │     │ PKCE loopback│
└─────────────┘     └──────────────┘     └─────────────────────┘     │ OAuth → JWT  │
                                                                   └──────┬───────┘
                                                                          │ Google token
                                                                          ▼
                                                                   ┌──────────────┐
                                                                   │   Gateway    │
                                                                   │ /auth/session│
                                                                   │ → Sunday JWT │
                                                                   └──────┬───────┘
                                                                          │ Bearer token
                                                                          ▼
                                                              ┌──────────────────────┐
                                                              │ sundayd (daemon)     │
                                                              │ AI requests          │
                                                              │ usage / entitlements │
                                                              └──────────────────────┘
```
