# Phase 8: Sunday Custom Interface — Design

**Goal:** Sunday's OWN interface on top of VS Code's engine. Stop fighting VS Code's UI internals; replace the surfaces users see with Sunday-owned UI.

**Principle:** ADD > REMOVE. We never delete VS Code workbench contributions (Beta.4 lesson). We *neutralize* via configuration and *supersede* via our own extension UI.

---

## 1. Audit — UI Surfaces

| # | Surface | Current state | VS Code owns | Sunday owns |
|---|---------|--------------|--------------|-------------|
| 1 | Welcome page | ✅ DONE (Phase 7) — redesigned hero, "Meet your agent", "Sunday Tours" | Layout engine | Content, branding, CTAs |
| 2 | Sign-in flow | ❌ BROKEN — VS Code's Copilot enterprise `chatSetup` flow hijacks; shows `[object Object]` + "Google instance" error | `chatSetupContributions`, `chatSetupRunner`, `chatSetupController` | `loginModal.ts` (own webview modal), `accountView.ts` (status bar) |
| 3 | Chat view | ⚠️ SPLIT — VS Code has builtin chat view; Sunday has own `sunday.chatView` in `sunday-agent` container | `chatViewContainer`, `chatViewsWelcome` | `chatView.ts`, `sunday-agent` activity-bar container |
| 4 | Command palette | ⚠️ SHARED — 52 Sunday commands registered, mixed with VS Code's | `quickaccess`, `commandsQuickAccess` | `contributes.commands` (52) |
| 5 | Settings UI | ⚠️ SHARED — `sunday.*` config namespaced, but UI is VS Code's | `preferences` contrib | `contributes.configuration` |
| 6 | Activity bar | ✅ OWN — `sunday-home` (☀️) + `sunday-agent` containers | Builtin containers (Explorer, Search, etc.) | 2 containers, own icons |
| 7 | Status bar | ✅ MOSTLY OWN — `accountView` status bar item | Builtin items | `registerAccountStatusBar` |
| 8 | Sidebar views | ✅ OWN — 5 views in Explorer + `sunday.homeView` + `sunday.chatView` | Builtin views | `managerView`, `mcpView`, `memoryView`, `rulesView`, `swarmView`, `browserView` |
| 9 | Title bar / menus | ❌ VS CODE — File/Edit/Selection/View/... | `titlebar`, `menubar` | Nothing |
| 10 | Accounts menu | ⚠️ SHARED — VS Code's accounts menu + Sunday's `accountView` | `authentication` contrib | `sunday.account.showMenu` |

---

## 2. Strategy per Surface

### 2.1 Sign-in flow (BROKEN → REPLACE)

**Problem chain:**
1. `product.json` → `defaultChatAgent.provider.enterprise = {id:'google',name:'Google'}` exists (required to prevent black-screen crash in `toDefaultAccountConfig`, which does `provider.enterprise.id` with no optional chaining).
2. `chatSetupRunner.ts:403` — `if (... && defaultAccountService.getDefaultAccountAuthenticationProvider().enterprise)` → truthy → forces `ChatSetupStrategy.SetupWithEnterpriseProvider`.
3. `chatSetupController.ts:361` — `getValue('')` on missing `providerUriSetting` returned the *entire config object* → `[object Object]` in the input. (Partially fixed: `providerUriSetting` now set to `sunday.enterpriseUri`.)
4. Validation message uses `provider.enterprise.name` = "Google" → "You must enter a valid Google instance" (a GitHub-Enterprise-ism).

**Strategy — neutralize, don't remove:**
- **Option A (config):** Set `defaultChatAgent.provider.enterprise` to a sentinel that `toDefaultAccountConfig` tolerates but that the auth-provider layer treats as absent. *Risk:* `toDefaultAccountConfig` does direct `.id`/`.name` access — any shape must have those keys. The `getDefaultAccountAuthenticationProvider().enterprise` boolean comes from `DefaultAccountProvider`, which derives it from the config. Needs source verification.
- **Option B (source patch, preferred):** Patch `chatSetupRunner.ts:403` to skip the enterprise-provider forcing when the default chat agent is Sunday's (`chatExtensionId === 'sunday.sunday-agent'`). Small, surgical, display-flow-only. Keeps the contribution registered (Beta.4-safe).
- **Option C (belt & suspenders):** B + ensure Sunday's `loginModal` is the *only* sign-in entry point users see: hide the title-bar "Sign in" indicator (`workbench.action.chat.signInIndicator`) via `menus` `when: false`, and route all sign-in CTAs (welcome page, status bar, command palette) to `sunday.account.showLoginModal`.

**APIs/services needed:** `vscode.authentication.getSession`, existing `sunday-google-auth` provider, `loginModal.ts` (exists), `accountView.ts` (exists).

**Effort:** M (source patch + menu hiding + verification).

### 2.2 Chat view (SPLIT → SUNDAY DEFAULT)

**Strategy:**
- Hide VS Code's builtin chat view container from the activity bar via `viewsContainers` ordering + `when` clauses on our views; ensure `sunday-agent` container is the default revealed chat.
- Contribute `viewsWelcome` content for `workbench.view.chat` that redirects to Sunday ("Sunday Agent lives here →") OR hide the builtin chat view entirely with `"when": "false"` on its menu registration.
- Set `chat.defaultChatAgent` / default participant to `@sunday` so `@sunday` is the implicit agent.

**APIs/services needed:** `contributes.viewsWelcome`, `contributes.menus` with `when`, `chatParticipants` (already contributed).

**Effort:** S (package.json contributions + small view-welcome content).

### 2.3 Command palette (SHARED → CURATE)

**Strategy:** Cannot replace the palette (it's core). Instead:
- Prefix discipline: all Sunday commands already use `sunday.*` — keep it.
- Add a "Sunday: ..." command group header via `commandPalette` menu grouping so Sunday commands cluster.
- Optionally contribute a dedicated quick-pick (`sunday.commandCenter`) as a Sunday-styled launcher — a webview quick-pick is overkill; skip unless user asks.

**Effort:** S.

### 2.4 Settings UI (SHARED → NAMESPACE)

**Strategy:** Cannot replace. Keep `sunday.*` namespaced configuration (already done). No work.

**Effort:** — (done).

### 2.5 Title bar / menus (VS CODE → LEAVE)

**Strategy:** Leave alone. Replacing the menubar is L effort with high regression risk and zero user-visible win (menus are functional, not brand surfaces). Branding is already in `product.json` (`nameShort: Sunday`).

**Effort:** L — explicitly out of scope.

### 2.6 Accounts menu (SHARED → REDIRECT)

**Strategy:** Sunday's `sunday.account.showMenu` already exists. Hide/avoid VS Code's accounts entry points where they conflict; keep the underlying `vscode.authentication` API (Sunday's Google/GitHub sign-in depends on it).

**Effort:** S.

---

## 3. Priority Order (top 3)

### P0 — Sign-in flow (§2.1)
*Why first:* It's **broken** and user-facing. The user hit it. Every new user hits it. Nothing else matters if sign-in is broken.
*Deliverable:* VS Code's enterprise chat-setup never triggers for Sunday; `sunday.account.showLoginModal` is the single sign-in entry; no `[object Object]`, no "Google instance".

### P1 — Chat view takeover (§2.2)
*Why second:* The agent is the product. If VS Code's chat view is visible alongside Sunday's, users are confused about "which chat is Sunday". One chat: Sunday's.
*Deliverable:* Builtin chat view hidden or redirecting; `@sunday` default; `sunday-agent` container is the chat home.

### P2 — Command palette curation (§2.3)
*Why third:* Discoverability. 52 Sunday commands exist but drown in VS Code's list. Grouping makes Sunday feel like a first-class citizen.
*Deliverable:* Sunday command group in palette.

---

## 4. Architecture

### Decision: EXTEND `sunday-agent` — do NOT create `sunday-shell`

**Rationale:**
- `sunday-agent` already owns: activation lifecycle, HostBridge, sidecar, views, commands, menus, chat participant, walkthroughs. A second extension duplicates activation, adds IPC surface, and doubles the packaging/test matrix.
- Interface-takeover logic is small (menu `when` clauses, viewsWelcome content, 1–2 source patches in `vscode/`). It fits in a new module.

**Structure:**
```
packages/ext-agent/src/
  shell/
    signInTakeover.ts      # P0: ensure VS Code chat-setup never hijacks; route to loginModal
    chatViewTakeover.ts    # P1: viewsWelcome redirect/hide for builtin chat
    paletteGrouping.ts     # P2: command-palette grouping (mostly package.json)
    shell.test.ts          # unit tests for pure logic
```

**`vscode/` source patches (surgical, display-flow-only):**
1. `chatSetupRunner.ts:403` — skip enterprise forcing when `chatExtensionId === 'sunday.sunday-agent'`.
2. (If needed) `chatSetupContributions.ts` — gate the title-bar sign-in indicator behind the same check.

Both keep contributions registered (Beta.4-safe). Both are covered by `scripts/verify-product-json.mjs` (no product.json shape change required).

**How we hide VS Code UI (allowed mechanisms):**
- `contributes.menus` with `"when": "false"` — hides builtin menu/command-palette entries.
- `contributes.viewsWelcome` — overrides empty-state content of builtin views.
- View container ordering — Sunday containers first.
- product.json — branding only; no structural deletions.

**Explicitly NOT doing:**
- Removing/renaming workbench contributions (Beta.4 lesson).
- Forking `quickaccess`, `preferences`, `titlebar` (L effort, high risk).
- A separate `sunday-shell` extension.

---

## 5. Effort Summary

| Item | Effort | Phase |
|------|--------|-------|
| P0 Sign-in takeover | M | 8.a |
| P1 Chat view takeover | S | 8.b |
| P2 Palette grouping | S | 8.c |
| Tests (shell.test.ts + existing suites) | S | each |

**Total: ~M.** No new extension, no workbench rewrites, no product.json shape changes.

---

## 6. Open Questions (for user)

1. P0 source patch touches `vscode/` (display-flow-only, Beta.4-safe). OK to proceed, or prefer config-only attempts first?
2. Should the builtin VS Code chat view be **hidden entirely** or show a **redirect** ("Sunday Agent lives in the ☀️ panel →")?
3. After P0–P2, is Phase 8 done, or are there other surfaces you want Sunday-owned?
