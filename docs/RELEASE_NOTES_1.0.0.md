# ☀️ Sunday IDE 1.0.0 — Release Notes

**Sunday is VS Code + Sunday features.** A full AI-native IDE: everything VS Code does (extensions, settings, themes, terminal, debugging), plus a deeply integrated AI agent, Sunday identity everywhere, and zero vendor lock-in.

---

## Highlights

### ✨ Sunday IDE Agent
- Dedicated agent window with a gold-sparkle activity-bar icon — not a chat panel bolted on
- Session persistence across webview reloads and restarts (per workspace folder)
- Plain-language errors with **Retry** when the gateway is unreachable — no more silent failures
- `@sunday` chat participant wired into native VS Code chat

### 🤖 Four models, zero setup
- **Auto**, **Llama 3.3 70B**, **Qwen 2.5 Coder 32B**, **Llama 3.1 8B** — via Sunday's hosted gateway
- Sign in with Google and start chatting. No API keys, no config files.
- Single source of truth (`sundayModels.ts`) with tests that fail if model lists drift

### 🎨 Sunday Dark & Light
- 518 color definitions each — terminal ANSI, status bar states, brackets, diff, menus, all covered
- Sunday yellow (`#f5b942`) status bar in Dark
- Full rebranding across every surface: welcome pages, settings, chat, issue reporter, update notifications — no "VS Code" or "Copilot" visible anywhere

### 🔐 Services
- Google + GitHub sign-in, free tier (200 requests/day, no credit card)
- Streaks with animated sidebar panel
- User Guide (`Ctrl+Alt+G`) with TOC, troubleshooting, interactive commands
- Sunday Home (☀️) panel: 21 features organized by category
- Auto-update with **SHA-256 hash verification** before install

### 📦 Open ecosystem
- Open VSX extension gallery (no Microsoft Marketplace lock-in)
- 100% VS Code compatible: extensions, settings, keybindings, themes all work
- Copilot extension **removed from the build** — Sunday ships its own agent instead

---

## Beta history

### Beta.1
First public beta. Sunday Home panel, core agent, black-screen root cause fixed (deleted `product.json` keys), Open VSX gallery, Sunday EXE icon.

### Beta.2
Google sign-in fixed (root cause: CI packaged extensions without compiling them — fixed with an explicit `tsc` step). Sunday Dark/Light themes, centered login modal, streak panel, `@sunday` participant, Open IDE Agent top-bar button.

### Beta.3
Sunday language-model provider (4 models via `vscode.lm`), theme auto-migration for saved stock VS Code themes, `sunday.theme.apply` one-click command, streak as side panel, guide + update top-bar buttons, dedicated Sunday IDE Agent activity-bar window.

### Beta.4 — ⚠️ broken, do not use
We removed VS Code's Copilot Agents view by deleting one import. That import registered `IAgentSessionsService`; without it, `MainThreadChatSessions` failed at startup and **the entire extension host died** — no agent, no themes, no commands. TypeScript compiled cleanly and CI was green; the failure was only visible in a real install. **Lesson learned the hard way: compile success ≠ runtime success.** Reverted immediately.

### Beta.5
The recovery release. AgentSessions restored (verified inside the packaged build). Copilot extension removed from packaging. P0–P3 branding (200+ display strings → Sunday). Theme polish (518 colors). Agent robustness (error handling, session persistence). Auto-updater hash verification. Version correctly set to `1.0.0-beta.5` (Beta.4's artifacts were internally still `beta.3` — caught by artifact verification before release).

---

## Known limitations (honest)

- **Windows installer** needs a real-machine install test (unsigned installers; see TODO(signing))
- **Google OAuth client ID** is hardcoded — if it's deleted/disabled, sign-in breaks for everyone
- **GitHub sign-in** doesn't create a Sunday session (falls back to Basic plan, no gateway JWT)
- **Streaks** are stored locally — reinstalling or switching machines resets them
- **Auto-update hash verification** is in warning mode until the gateway's `/updates/check` endpoint includes a `sha256` field
- **OAuth loopback** fallback if the local callback server is blocked
- Agent modes are Auto / Architect / Implementer / Reviewer (as implemented)

---

## Download

**[GitHub Releases](https://github.com/Vivek492005/Sunday/releases)** — Windows (x64, system + user installers), Linux (x64 tarball), macOS (arm64 DMG), plus `sunday-agent.vsix`.

After installing any beta, future updates arrive through the IDE's **auto-update button** — no manual downloads needed.
