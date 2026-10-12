# ☀️ Sunday IDE — Rebuild Plan (Option A: Own the Fork)

**Vision:** Sunday is VS Code + Sunday features — lekin ab VS Code ko sirf use nahi karenge, usko **OWN** karenge. Har module samajh ke, dependency map ke saath, bina regression ke systematic Sunday-fication.

**Core Principle (Beta.4 se seekha):** ADD karna safe hai, REMOVE karna dangerous hai. Har change se pehle dependency audit mandatory hai.

---

## 🧩 CLUSTERS (Work Streams)

| Cluster | Naam | Scope |
|---|---|---|
| A | **Shell Identity** | Theme, activity bar, sidebar, status bar, title bar, icons, branding — IDE ka dikhna |
| B | **Agent Platform** | Sunday IDE Agent, models, @sunday, chat, agent modes — AI ka dil |
| C | **Extension World** | Open VSX gallery, extension management, marketplace UI |
| D | **Core IDE** | Editor, terminal, settings, keybindings, file explorer, search, debug — VS Code ka kaam karna |
| E | **Sunday Services** | Auth (Google/GitHub), gateway, billing/quotas, streaks, memory, MCP, updates |
| F | **Build & Release** | CI/CD, packaging, auto-update, releases, verification |

---

## 📋 PHASES

### PHASE 0 — Foundation & Safety (Current)
**Goal:** Dobara kabhi regression na ho. Har change verified.

- [x] Beta.4 regression root-cause (agentSessions → IAgentSessionsService → MainThreadChatSessions)
- [ ] `docs/WORKBENCH_DEPENDENCY_MAP.md` — poore workbench ka map (agent kaam kar raha hai)
- [ ] `docs/SAFE_CHANGE_GUIDELINES.md` — har change se pehle mandatory checklist
- [ ] Beta.5 release (revert + sab fixes) — PAT milte hi build
- **Exit:** Dependency map + guidelines ready, Beta.5 green aur verified

### PHASE 1 — Audit & Ownership
**Goal:** Pata ho har file kya karti hai, kya chhed sakte hain.

- [ ] Workbench `contrib/` ka module-wise audit (Cluster D pehle — core IDE)
- [ ] Branding audit: bachi hui "VS Code" / "Copilot" / "HydraFusion" strings ki list
- [ ] Extension host API surface audit: Sunday kya-kya use karta hai
- [ ] Product.json / package.json ka full ownership review
- **Exit:** Har cluster ka "safe to touch" / "do not touch" list ready

### PHASE 2 — Shell Identity (Cluster A)
**Goal:** IDE khulte hi lage — ye Sunday hai, VS Code nahi.

- [ ] Sunday Dark/Light theme polish (status bar, activity bar, sidebar — sab Sunday)
- [ ] Theme migration robust (purani installs bhi yellow)
- [ ] Activity bar: Sunday Home ☀️ + Sunday IDE Agent ✨ prominent
- [ ] Status bar: Sunday items, sahi size/visibility
- [ ] Title bar, window icon, walkthrough — 100% Sunday branding
- [ ] Bachi hui VS Code/Copilot strings ka safaya (audit se)
- **Exit:** Fresh install pe zero VS Code dikhe, sirf Sunday

### PHASE 3 — Agent Platform (Cluster B)
**Goal:** Sunday ka agent sabse best lage, sab kuch kaam kare.

- [ ] Sunday IDE Agent window polish (sessions, history, input)
- [ ] 4 models stable (lm provider + fallback) — native chat me bhi
- [ ] @sunday participant robust
- [ ] Agent modes (Architect/Code/Debug/Ask) UI me clear
- [ ] Copilot-dependent surfaces ka safe handling (hide nahi, toh gracefully degrade)
- **Exit:** User kabhi "agent not working" na bole

### PHASE 4 — Sunday Services (Cluster E)
**Goal:** Sign-in se lekar billing tak sab seamless.

- [ ] Google/GitHub sign-in end-to-end verified (packaged build me)
- [ ] Centered login modal polish
- [ ] Gateway + quota + plans (Free/Basic/Smart/Pro) wired
- [ ] Streaks panel polish, rewards working
- [ ] Auto-update button → one-click update working
- [ ] User Guide + walkthrough final
- **Exit:** Naya user sign-in se lekar pehle agent reply tak bina atke jaye

### PHASE 5 — Core IDE Hardening (Cluster D)
**Goal:** "Sunday is VS Code" — 100% kaam kare.

- [ ] Extensions install/enable/disable — Open VSX se verified
- [ ] Settings, keybindings, themes (third-party) sab kaam karein
- [ ] Terminal, debugger, search, file explorer — smoke tests
- [ ] Performance: startup time, memory — VS Code ke barabar
- **Exit:** Koi bhi VS Code user bina seekhe Sunday chala sake

### PHASE 6 — v1.0 Release (Cluster F)
**Goal:** Pehla asli release.

- [ ] Full CI green (Windows/Linux/macOS)
- [ ] Artifact verification (11-check wali process)
- [ ] Release notes, landing page download links
- [ ] Auto-update Beta.5 → v1.0 tested
- **Exit:** `ide-v1.0.0` public, user install karke khush

---

## ⚠️ RULES (Non-negotiable)

1. **Dependency audit pehle, change baad me** — bina map dekhe koi workbench file mat chhedo
2. **ADD > REMOVE** — naya banao, purana mat todo (jab tak map na kahe safe hai)
3. **Har release se pehle artifact verification** — khol ke andar dekho, phir release
4. **Har phase ke baad LONG HARD TEST** — comprehensive cross-verification; bina pass kiye phase "done" nahi
5. **User ke screenshots = bug reports** — fix karo, explain mat karo
6. **100% standard** — partial fix release mat karo
7. **Decision chahiye toh pucho** — assume mat karo, user se pucho

---

## 📊 Progress Tracking

Har phase ke baad `docs/PROGRESS.json` update hoga. Current: Phase 0 (in progress).
