# ☀️ Sunday IDE — Complete Project Handoff for Claude

**Purpose:** This document gives Claude (or any AI assistant) the full context to continue building the Sunday IDE — our own IDE with Sunday's agent, using VS Code's functionality.

**Last updated:** 2026-10-12

---

## 1. What is Sunday?

**Sunday is VS Code + Sunday features.** It's a full IDE built by forking VS Code 1.140.0, with:
- Sunday's own AI agent (Sunday IDE Agent window, @sunday chat participant, 4 models via Sunday gateway)
- Sunday branding everywhere (themes, icons, strings — zero "VS Code" visible)
- Google/GitHub sign-in, streaks, user guide, auto-update
- Open VSX as the extension gallery (NOT Microsoft Marketplace)

**Repo:** https://github.com/Vivek492005/Sunday
**Local:** `~/workspace/sunday-product` (product workspace at repo ROOT)
**Landing:** https://vivek492005.github.io/Sunday/
**User:** Vivek Bartwal (timezone Asia/Calcutta) — communicates in Hinglish, expects 100% completion, hates rework

---

## 2. The Story: Our Fall with VS Code

### What we did (Oct 1-10, 2026)
We vendored the entire VS Code 1.140.0 source (~19,000 files, ~310MB) into our repo under `vscode/`. We built:
- Sunday Home panel (☀️ activity bar icon, 21 features)
- Sunday IDE Agent (✨ dedicated agent window)
- Sunday Dark/Light themes
- Google sign-in, streaks, user guide, auto-update
- Released Beta.1 through Beta.4

### The Fall: Beta.4 (Oct 11, 2026)
**What happened:** We tried to remove VS Code's Copilot-based Agents view by deleting an import:
```typescript
// REMOVED from vscode/src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts:
import './agentSessions/agentSessions.contribution.js';
```

**Why it broke everything:** That import didn't just show UI — it registered `IAgentSessionsService`. Without it:
1. `MainThreadChatSessions` constructor (which injects `@IAgentSessionsService`) failed
2. Extension host threw: `Missing proxy instance MainThreadChatSessions`
3. **Every extension died** — no agent, no theme, no guide, no commands

**The painful part:** TypeScript compiled cleanly. CI was green. 11 artifact checks passed. But the shipped build was completely broken. The user discovered it on their real Windows machine.

**The fix:** Reverted the import (commit `fdd2495f`). Lesson: **compile success ≠ runtime success.**

### Why we didn't see it coming
We had only read ~50-60 files out of 19,000+. We didn't understand the dependency chains. We treated VS Code like a UI we could edit, but it's a tightly coupled system where:
- Workbench contributions register services via side effects (imports)
- 78 `MainThread*` proxies assert at extension-host startup
- Removing one import can kill the entire extension host

---

## 3. Why We Shifted: Option A (Own the Fork)

The user proposed building a new IDE UI "from scratch" while reusing VS Code functionality. We presented two options:

**Option A (CHOSEN):** Systematically own the fork — map dependencies first, then modify carefully while preserving services.

**Option B (REJECTED):** New IDE from scratch (Monaco + new extension system) — multi-year effort, effectively rewriting VS Code.

**Why Option A:** VS Code's shell and functionality are inseparable. Settings, extensions, editor, chat, and services are not clean modules. Option A lets us achieve "Sunday is VS Code + Sunday features" without a rewrite.

### The New Rules (non-negotiable)
1. **Dependency audit before workbench changes** — check `docs/WORKBENCH_DEPENDENCY_MAP.md` first
2. **ADD > REMOVE** — build new, don't delete old (unless map says safe)
3. **Verify in built artifacts** — open the package, check inside, then release
4. **Long hard test after every phase** — no phase is "done" without comprehensive verification
5. **Ask user on decisions** — don't assume, don't guess
6. **100% standard** — no partial fixes, no rework

---

## 4. Current State (as of 2026-10-12)

### Completed Phases
- **Phase 0 (95%):** Dependency map (335 lines), safe-change guidelines, Beta.5 rebuild in progress
- **Phase 1 (100%):** Core IDE audit (15 modules with danger ratings), branding audit (189 files)
- **Phase 2 (100%):** P0/P1/P2/P3 branding (all "VS Code"/"Copilot" → "Sunday" in display strings), theme polish (518 colors each), activity/status bar polish
- **Phase 3 (100%):** Agent robustness (error handling, session persistence, single model source, 32 tests)
- **Phase 4 (100%):** Services audit, P0 security fix (auto-updater hash verification), P1 fixes (PlanId, timeout, URL consolidation, version guard)

### Key Commits (all on main)
- `fdd2495f` — Revert: restored agentSessions (fixed Beta.4)
- `ce97c304` — Removed Copilot extension from build packaging
- `dda954f6` — P0 branding (chat/agent surfaces)
- `4a830574` — P1 branding (welcome/getting started)
- `f522589b` — P2/P3 branding (settings, misc)
- `e5d2cc5d` — Theme polish
- `e29658d2` — Activity/status bar polish
- `0f7e3a00` — Agent robustness
- `c19b3250` — Auto-updater hash verification (P0 security)
- `bbbff91d` — P1 fixes (PlanId, timeout, URLs, version guard)

### Key Documents
- `docs/WORKBENCH_DEPENDENCY_MAP.md` — 100 contrib folders, 78 proxies, danger zones
- `docs/SAFE_CHANGE_GUIDELINES.md` — 6-step checklist before removing anything
- `docs/PHASE1_CORE_IDE_AUDIT.md` — 15 modules with danger ratings
- `docs/PHASE1_BRANDING_AUDIT.md` — 189 files, P0-P3 fix list
- `docs/PHASE4_SERVICES_AUDIT.md` — Sign-in, gateway, quota, update, streaks audit
- `docs/SUNDAY_IDE_REBUILD_PLAN.md` — 7 phases, 6 clusters, 7 rules

---

## 5. Architecture: How Sunday Works

### Our Code (safe to modify freely)
```
packages/ext-agent/          # Sunday's VS Code extension (agent, chat, views, commands)
  src/
    chatView.ts              # Sunday IDE Agent webview
    sundayModelProvider.ts   # 4 models via vscode.lm API
    sundayModels.ts          # Single source of truth for models
    extension.ts             # Activation, command registration
    engagement/              # Streaks, activity
    update/                  # Auto-updater (now with hash verification)
    userGuide.ts             # User guide (Ctrl+Alt+G)

vscode/extensions/
  theme-sunday/              # Sunday Dark/Light themes (518 colors each)
  sunday-google-auth/        # Google OAuth extension
```

### VS Code Fork (modify carefully — see dependency map)
```
vscode/src/vs/workbench/     # Workbench (UI + services)
  contrib/                   # 100 feature modules
  api/browser/               # 78 MainThread* proxies
  services/                  # Core services

vscode/product.json          # Product identity (Sunday branding)
vscode/build/                # Build system (gulp)
```

### What we changed in the fork
- **Branding:** Display strings only ("VS Code" → "Sunday", "Copilot" → "Sunday")
- **Build:** Removed Copilot extension packaging (`gulpfile.vscode.ts`, `gulpfile.reh.ts`, CI)
- **product.json:** `defaultChatAgent` → `sunday.sunday-agent`
- **NEVER:** Removed service registrations, modified DI, touched proxy code

### Danger Zones (from dependency map)
- 🔴 **DANGER:** files, search, terminal, debug, extensions, scm, notebook, tasks
- 🟡 **CAUTION:** preferences, output, timeline, comments, remote
- 🟢 **SAFE:** themes, markers (Problems panel)

---

## 6. What's Remaining

### Phase 5 — Core IDE Hardening (not started)
- Extensions install/enable/disable via Open VSX — verify works
- Settings, keybindings, third-party themes — smoke test
- Terminal, debugger, search, file explorer — verify all work
- Performance: startup time, memory usage

### Phase 6 — v1.0 Release (not started)
- Full CI green on all platforms
- Artifact verification (open package, check inside)
- Release notes, landing page updates
- Beta.5 → v1.0 auto-update test

### Known P1 Items (deferred — need user/external)
- Google OAuth client ID backup (user must create)
- GitHub sign-in → Sunday session (needs product decision)
- Streak sync across machines (needs gateway API)
- Windows installer real-machine test (needs user)

---

## 7. How to Work on This Project

### Before touching `vscode/src/vs/workbench/`:
1. Read `docs/WORKBENCH_DEPENDENCY_MAP.md` §4 (danger zones)
2. Run the 6-step checklist from `docs/SAFE_CHANGE_GUIDELINES.md`
3. If removing anything: STOP and verify with grep that no service/proxy depends on it

### Before any release:
1. Version must match in `packages/ext-agent/package.json` (CI now guards this)
2. Download artifacts, inspect inside (don't trust CI alone)
3. Check: no "Missing proxy" errors, correct version, all extensions present

### Commit conventions
- `feat(ide):` — new IDE features
- `fix(ide):` — IDE bug fixes
- `fix(security):` — security fixes
- `fix(build):` — build system fixes
- `fix(ci):` — CI workflow fixes
- `fix(release):` — version/release fixes
- `chore(repo):` — repo maintenance

### User communication style
- Hinglish is fine, user uses it
- Be direct, no fluff ("Great question!" etc.)
- Lead with the answer, then details
- When stuck or need a decision: ASK immediately, don't guess
- Never claim "done" without verification

---

## 8. Critical Lessons (never forget)

1. **Beta.4:** `tsc` clean + CI green ≠ working build. Always verify inside artifacts.
2. **Beta.4:** Removing a workbench import can kill the entire extension host. Always audit dependencies first.
3. **Beta.5:** Version in `package.json` must match release tag. CI now has a version guard.
4. **Beta.5:** Removing an extension from build also requires removing its build dependencies (the copilot ripgrep shim threw because SDK wasn't installed).
5. **Black screen (Beta.1):** Never delete keys from `product.json` — only change values. CI now guards critical keys.
6. **Google sign-in (Beta.2):** CI packages extensions but doesn't compile them — need explicit `tsc` step.

---

**This document is the brain of the project. Read it before doing anything.**
