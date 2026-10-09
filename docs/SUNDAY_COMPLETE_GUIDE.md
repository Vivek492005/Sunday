# Sunday — Complete Guide

**Version:** 1.0.0-beta.1 | **Last updated:** 2026-10-09
**License:** Apache-2.0 (open source) | **Repo:** github.com/Vivek492005/Sunday

---

## 1. What is Sunday?

Sunday is an **AI-native, agent-driven IDE** — a full fork of VS Code 1.140.0,
rebuilt around autonomous coding agents. Instead of AI sitting in a sidebar
suggesting completions, Sunday's agents plan, execute, test, and iterate on
development tasks across the editor, terminal, and browser.

**One-line pitch:** *Your home for agent-driven development — tell it what to
build, review what it ships.*

### How it works (the 10-second version)

1. **Sign in** with Google, GitHub, or Microsoft — no API keys needed.
2. **Describe the task** in plain language ("add auth to the dashboard", "fix
   this bug and add tests").
3. **Agents execute** — they edit files, run terminal commands, browse the web,
   and verify their work.
4. **You review** — every change is presented for approval before it lands.

---

## 2. Complete Feature List

### 2.1 AI Agents (the core)

| Feature | Description |
|---|---|
| **Autonomous agents** | Multi-step task execution: plan → implement → test → verify |
| **Parallel agents** | Up to 4 agents working simultaneously (Pro tier) |
| **Swarm / orchestrator** | A coordinator agent that fans work out to sub-agents |
| **Mission-control dashboard** | Central view of all running agents, tasks, and progress |
| **Agent Manager view** | Orchestrate and monitor agents across workspaces |
| **Best-of-N** | Generate multiple candidate solutions, pick the best |
| **Cloud tasks** | Offload long-running agent work to the cloud |
| **Scheduler / cron tasks** | Schedule agents to run on a timetable |
| **Proactive mode** | Agents suggest next steps without being asked |
| **Learning loop** | Agents improve from your feedback over time |
| **Second Brain** | Persistent knowledge base of your project context |
| **Repo onboarding** | Agent reads a new repo and explains the architecture |
| **Design-to-code** | Feed a mockup/screenshot → get functional frontend code |
| **Browser agent** | Agents interact with real web pages (E2E testing, scraping) |
| **Terminal proxy** | PowerShell-aware agent terminal execution (Windows-first) |

### 2.2 Editor Intelligence

| Feature | Description |
|---|---|
| **Full VS Code fork** | Every VS Code feature works — extensions, themes, keybindings, settings |
| **Smart autocomplete** | Context-aware completions across the whole project |
| **Multi-file editing** | Agents refactor across files in one instruction |
| **E2E session sync** | Agent sessions sync across devices |
| **Artifacts panel** | Plans, logs, screenshots, and recordings generated as verifiable outputs |

### 2.3 Personalization (B1–B5)

| Feature | Description |
|---|---|
| **AGENTS.md awareness** | Agents read your repo's agent instructions automatically |
| **Style inference** | Learns your coding style and matches it |
| **Templates** | Reusable prompt templates for common workflows |
| **Modes** | Different agent personalities/behaviors per task type |
| **Memory learning** | Remembers your preferences across sessions |

### 2.4 Gamification / Engagement 🔥

Sunday rewards **shipped work, not app opens** — a deliberate design choice.

| Feature | Description |
|---|---|
| **Coding streaks** | Tracked for meaningful actions only: commits, 30+ min active edits, merged PRs, successful AI tasks. Merely opening the app doesn't count. Status bar shows `🔥 N`. |
| **Streak Freeze** | Earn 1 per 7 streak days (max 3 stored); auto-consumed after a missed qualifying day |
| **Vacation Mode** | Pause streaks up to 14 days/year without losing progress |
| **Streak bonus quota** | 7-day streak → +100 AI requests/day · 14-day → +200/day · 30-day → +500/day (stacks on top of paid plan limits) |
| **Two-mode design** | *Passive mode* (just editing): silent streak tracking, no popups. *Active mode* (using agents): full quests, XP, achievements. Normal VS Code work is never interrupted. |
| **Milestones & at-risk alerts** | Gentle notifications when a streak milestone nears or is at risk |

*Planned (designed, not yet shipped): daily quests, achievements, proficiency ranks (Novice→Master), squads, weekly leagues.*

### 2.5 Authentication & Accounts

| Feature | Description |
|---|---|
| **Zero-config AI** | Sign in → get 200 free AI requests/day. No API keys to set up, no billing required to start. |
| **Google / GitHub / Microsoft sign-in** | Built-in OAuth; Sunday session layered on top with auto-refresh |
| **Account status bar UI** | Always-visible sign-in state |
| **Account-switch protection** | Max 2 distinct accounts per provider per machine per 24h (anti-abuse); paid users bypass |
| **Separate admin gateway** | Allowlist-based admin login (`/admin/*`), 8h sessions, audit logs |
| **One-click repo import** | Clone any GitHub repo into Sunday in one click |

### 2.6 Billing (Paddle — Merchant of Record)

India-first pricing, GST-inclusive, UPI supported:

| Tier | Price/mo | Requests/day | Agents | Browser |
|---|---|---|---|---|
| Free | ₹0 | 200 | 1 | — |
| Basic | ₹149 | 500 | 2 (sequential) | 5 sessions/day |
| Smart | ₹349 | 1,200 | 3 (sequential) | 15 sessions/day |
| Pro | ₹799 | 3,000 | 4 (parallel) | Unlimited |

*Paddle handles all tax/GST globally as Merchant of Record.*

### 2.7 Updates & Platform

| Feature | Description |
|---|---|
| **Auto-update** | One-click updates from inside the IDE (Help → Check for Updates) |
| **Beta channel** | Beta users get prerelease updates; stable users never see betas |
| **Platforms** | Windows (x64), macOS (ARM64), Linux (x64) |
| **Extension gallery** | Open VSX (open-source marketplace) |
| **Usage dashboard** | Track AI request consumption and entitlements |

---

## 3. Sunday vs VS Code

| Dimension | VS Code | Sunday |
|---|---|---|
| **Base** | — | Full fork of VS Code 1.140.0 — everything works |
| **AI model** | Copilot (paid add-on, ~$10/mo) | Built-in agents, 200 req/day free, no keys needed |
| **Agent autonomy** | Chat + completions; you drive | Agents plan, execute, test, verify — you review |
| **Parallel agents** | ❌ | ✅ Up to 4 (Pro) with Manager view |
| **Browser control** | ❌ (extensions only) | ✅ Native browser agent |
| **Gamification** | ❌ | ✅ Streaks, freezes, vacation mode, bonus quota |
| **Zero-config start** | ❌ (Copilot setup + subscription) | ✅ Sign in → immediately usable |
| **Pricing (India)** | Free editor + $10/mo Copilot | Free tier genuinely usable; paid from ₹149/mo |
| **Open source** | Source-available (not OSI) | ✅ Apache-2.0, fully open |
| **Extension ecosystem** | Marketplace (proprietary) | Open VSX (open) + VSIX sideload |

**Bottom line:** If you like VS Code but want agents that *do the work*
instead of just suggesting code — and you want it free to start, open source,
and priced for India — Sunday is VS Code evolved.

---

## 4. Sunday vs Google Antigravity

Antigravity (Google, public preview since Nov 2025) is the closest product in
spirit: an agent-first IDE where AI works across editor, terminal, and browser.
Here's the honest comparison.

### Where they're similar

Both are agent-first IDEs: autonomous agents that plan, execute, and verify
across editor + terminal + browser; parallel multi-agent orchestration;
artifacts (plans, screenshots, recordings) for transparency; natural-language
"describe what you want" workflows.

### Where they differ

| Dimension | Google Antigravity | Sunday |
|---|---|---|
| **AI models** | Gemini 3 Pro (+ Claude, GPT-OSS); Google's frontier models | Hosted gateway (OpenRouter + Groq free-tier open models); BYOK supported |
| **Model quality** | Frontier (Gemini 3) — best-in-class reasoning | Good open models; trades peak reasoning for cost |
| **Benchmarks** | ~76% SWE-bench (reported) | Not yet benchmarked (beta) |
| **Browser integration** | Deep Chrome integration, visual testing | Browser agent included; Chrome-depth TBD |
| **Knowledge base** | Built-in knowledge artifacts | Second Brain + learning loop (similar concept) |
| **Gamification** | ❌ None | ✅ Streaks, freezes, bonus quota — unique to Sunday |
| **Pricing** | Free preview; ~$20/mo Pro expected (~₹1,700) | Free 200/day; paid from **₹149/mo** — ~10x cheaper in India |
| **Open source** | ❌ Proprietary (Google) | ✅ Apache-2.0 — fork it, audit it, self-host the gateway |
| **Offline/local** | ❌ Cloud-dependent | Extension + daemon work locally; gateway needed only for hosted AI |
| **India-first** | ❌ Global pricing | ✅ UPI, GST-inclusive INR pricing, Paddle MoR |
| **Maturity** | Google-backed, public preview, large team | Indie beta, small team, shipping fast |
| **Ecosystem** | Google's distribution | Community-driven, open roadmap |

### Honest assessment

- **Choose Antigravity if:** you want the absolute best model reasoning
  (Gemini 3), Google's reliability, and don't mind proprietary software at
  ~$20/mo.
- **Choose Sunday if:** you want an *open-source* agent IDE, India-friendly
  pricing (₹149 vs ~₹1,700), gamified coding streaks, zero-config free tier,
  and the ability to audit or self-host the whole stack.

Sunday's bet: **openness + affordability + engagement** beats raw model power
for the next billion developers — especially in India.

---

## 5. Feature Status Summary

| Status | Features |
|---|---|
| ✅ Shipped (Beta.1) | All of §2 except where noted |
| 📋 Designed, not yet built | Quests, achievements, ranks, squads, leagues (E.2–E.5); Paddle billing implementation (deferred by user) |
| 🔬 Verifying | Real-world Windows auto-update; end-to-end streak bonus quota |

---

*Built with ❤️ in India. Sunday is open source — contributions welcome.*
