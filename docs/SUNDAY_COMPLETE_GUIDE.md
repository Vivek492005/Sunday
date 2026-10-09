# Sunday — The Deep Dive

**Version:** 1.0.0-beta.1 | **Last updated:** 2026-10-09
**License:** Apache-2.0 (fully open source) | **Repo:** github.com/Vivek492005/Sunday

> This document is the definitive reference for what Sunday is, how it works
> under the hood, every feature it ships, and how it compares — honestly —
> against VS Code and Google Antigravity.

---

## Table of Contents

1. [What Sunday Is (and Isn't)](#1-what-sunday-is-and-isnt)
2. [System Architecture](#2-system-architecture)
3. [Feature Deep Dive](#3-feature-deep-dive)
4. [Sunday vs VS Code](#4-sunday-vs-vs-code)
5. [Sunday vs Google Antigravity](#5-sunday-vs-google-antigravity)
6. [Business Model & Pricing](#6-business-model--pricing)
7. [Roadmap & Status](#7-roadmap--status)

---

## 1. What Sunday Is (and Isn't)

### The one-paragraph version

Sunday is an **AI-native, agent-driven IDE** built as a full fork of VS Code
1.140.0. Where VS Code treats AI as a sidebar assistant that suggests code,
Sunday treats AI as a **workforce**: autonomous agents that plan multi-step
tasks, edit files, run terminal commands, control a browser, verify their own
work, and present results for your review. You describe outcomes; agents handle
execution.

### What it isn't

- **Not a VS Code extension.** It's a complete standalone application with its
  own branding, installer, update channel, and data folder (`~/.sunday`). The
  `sunday-agent` extension *also* exists as a VSIX for stock VS Code users, but
  the flagship product is the full IDE.
- **Not a Copilot clone.** Copilot completes code you were already writing.
  Sunday's agents take a goal ("add OAuth to this Express app, with tests")
  and return a finished, tested change.
- **Not a cloud-only toy.** The IDE, extension host, and agent daemons all run
  locally on your machine. Only hosted AI inference goes through Sunday's
  gateway — and you can bring your own keys or point at Ollama instead.

### Who it's for

- **Students & early-career devs** (especially in India): zero-config free
  tier, no credit card, no API keys. Install → sign in with Google → build.
- **Indie hackers & solo builders**: parallel agents + scheduler = a one-person
  team that ships like three.
- **Teams that want openness**: Apache-2.0 means you can audit every line,
  self-host the gateway, and never worry about vendor lock-in.

---

## 2. System Architecture

Sunday is a **monorepo** (`pnpm` workspaces) with five runtime components.
Understanding this architecture explains why features behave the way they do.

```
┌─────────────────────────────────────────────────────────────┐
│  SUNDAY IDE (Electron app — VS Code 1.140.0 fork)           │
│  ┌──────────────────┐  ┌────────────────────────────────┐   │
│  │  Workbench UI    │  │  Extension Host (separate      │   │
│  │  (renderer proc) │  │  process — a crash here can    │   │
│  │                  │  │  NEVER black-screen the IDE)   │   │
│  └──────────────────┘  └────────────────────────────────┘   │
│                                │                            │
│                    ┌───────────┴───────────┐                │
│                    │  sunday-agent ext     │                │
│                    │  (dist/extension.cjs,  │                │
│                    │   esbuild bundle)     │                │
│                    └───────────┬───────────┘                │
└────────────────────────────────┼────────────────────────────┘
                                 │ NDJSON-over-stdio JSON-RPC
                    ┌────────────┴────────────┐
                    │  sundayd (agent daemon) │◄── child process
                    │  - tool execution       │
                    │  - file/terminal ops    │
                    └────────────┬────────────┘
                                 │ lazy child
                    ┌────────────┴────────────┐
                    │  browserd (Playwright)  │◄── browser automation
                    │  - real Chromium       │
                    │  - screenshots, clicks │
                    └─────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  HOSTED GATEWAY (Node.js, Render — sunday-final-ide         │
│  .onrender.com)                                             │
│  - OAuth session issuance (Google/GitHub/Microsoft)         │
│  - OpenAI-compatible /v1/chat/completions                   │
│  - Providers: OpenRouter + Groq (server holds keys)         │
│  - Quota metering, entitlements, streak bonuses             │
│  - /updates/check (auto-update feed), /admin/*              │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 The IDE (Electron fork)

- **Base:** VS Code 1.140.0 source, vendored under `vscode/` (~19,000 files).
  **Zero changes** to `vscode/src/` — the workbench JavaScript is byte-identical
  to upstream. All customization is configuration-level (`product.json`),
  branding assets, and bundled extensions.
- **What changed vs stock VS Code:**
  - `product.json`: Sunday branding (`.sunday` data folder, `sunday://` URL
    protocol, Sunday app IDs/icons), **Open VSX** as the extension gallery
    (instead of Microsoft's proprietary Marketplace), and `defaultChatAgent`
    pointed at `sunday.sunday-agent`.
  - **Two built-in extensions:** `sunday-agent` (staged from the VSIX at build
    time) and `sunday-google-auth` (OAuth provider).
  - Sunday logo app icons (`.ico`/`.icns`/`.png`).
- **Why a fork instead of just an extension?** Three reasons: (1) the
  `defaultChatAgent` slot and gallery URL can only be set at build time;
  (2) zero-config onboarding (no "install this extension first" step);
  (3) a distinct product identity users can download and trust.

### 2.2 The extension (`packages/ext-agent`)

- Published as `sunday-agent` (also installable as a VSIX in stock VS Code).
- Entry: `dist/extension.cjs` — a single esbuild bundle (~90 source modules).
- Activates on `onStartupFinished`; spawns `sundayd` as a child process.
- Communicates with the daemon over **typed RPC** (`hostBridge.ts`).
- UI surfaces: chat webview (`@sunday/ui-chat`), manager webview
  (`@sunday/ui-manager`), artifacts panel, status bar, scheduler UI.
- Key subsystems: agent engine, orchestration (swarm), tool execution,
  inline completions/edits, engagement (streaks), entitlements, update service.

### 2.3 The daemons (`sundayd` + `browserd`)

- **`sundayd`**: the agent runtime sidecar. Runs as a child process of the
  extension. Executes tools: file reads/writes, terminal commands
  (PowerShell-aware on Windows), search, and task orchestration.
- **`browserd`**: Playwright-based browser automation, spawned lazily by
  `sundayd`. Gives agents a real Chromium: navigate, click, screenshot,
  inspect network — enabling E2E testing and web research inside agent tasks.
- **Protocol:** NDJSON-over-stdio JSON-RPC with a shared codec
  (`rpc-transport.ts`); shared message types live in `@sunday/protocol`.
  Also supports `node:net` sockets for advanced setups.

### 2.4 The hosted gateway (`packages/hosted-gateway`)

- A lean Node.js server using **raw `node:http`** (no Express) with a custom
  router (`server.ts`) — 15 endpoints.
- **Auth:** `/auth/session`, `/auth/refresh`, `/auth/logout` — exchange a
  Google/GitHub/Microsoft OAuth token for a Sunday session (with auto-refresh).
  Google-only fallback when the gateway is unreachable.
- **Inference:** OpenAI-compatible `/v1/chat/completions` + `/v1/models`.
  The server holds provider keys; the IDE never sees them. Providers:
  **OpenRouter** + **Groq** (default route:
  `openrouter:meta-llama/llama-3.3-70b-instruct`); `ollama` supported for local.
- **Quota:** per-user daily metering with `base` vs `streak_bonus` buckets;
  entitlements computed by `recomputeEntitlements()`.
- **Updates:** public `GET /updates/check?platform&current` — IP-rate-limited,
  10-minute GitHub cache, beta-channel aware (queries the `/releases` list and
  normalizes `ide-v1.0.0-beta.N` tags; stable users are never offered betas).
- **Admin:** `/admin/login|logout|refresh|me` — allowlist via
  `SUNDAY_ADMIN_EMAILS`, 8-hour JWT sessions, hashed-email audit logs.
- **Anti-abuse:** max 2 distinct accounts per provider per machine per 24h
  (tracked in `signin_log.json`; paid tiers bypass).
- **Deployment:** Render (`sunday-final-ide.onrender.com`), hardcoded as
  `DEFAULT_GATEWAY_URL` in the extension. ⚠️ Current storage is JSON files —
  Postgres migration is planned for production hardening.

### 2.5 Data & privacy

- **Local-first:** engagement data lives in `~/.sunday/engagement/`
  (`activity.json`, `streak.json`, mode `0600`); 400-day retention.
- **What leaves your machine:** OAuth tokens (to get a Sunday session),
  prompts sent to the hosted gateway for inference, and the
  `X-Sunday-Streak-Days` header (client-reported streak count — signed
  attestations are a planned hardening).
- **What doesn't:** your files are read by the *local* daemon; only the
  prompts you send go to the gateway.

---

## 3. Feature Deep Dive

### 3.1 Autonomous agents — how they actually work

A Sunday agent task follows a **plan → act → verify** loop:

1. **Plan.** The agent decomposes your natural-language request into steps
   (shown in the chat UI as a task list you can edit).
2. **Act.** Each step executes tools via `sundayd`: read files, write code,
   run terminal commands, search the web, control the browser.
3. **Verify.** The agent runs tests/linters, screenshots UI changes via
   `browserd`, and self-reviews the diff.
4. **Present.** You get a summary + diff + test results. Nothing is applied
   without your approval (configurable autonomy levels).

**Parallel agents (Pro):** up to 4 agents on different tasks simultaneously,
visible in the Manager view with per-agent progress and logs.

**Swarm/orchestrator:** for big tasks, a coordinator agent splits work across
sub-agents (e.g., "backend agent builds the API, frontend agent builds the UI")
and merges results.

**Best-of-N:** ask for N candidate solutions to a tricky problem; the system
ranks them and you pick.

**Scheduler:** cron-like agent tasks — "every morning, summarize my repo's
open PRs and draft review comments."

### 3.2 Engagement: reward shipped work, not app opens 🔥

This is Sunday's most opinionated design decision. Most "gamified" tools reward
logins; Sunday rewards **output**.

**What counts toward a streak** (and only these):
- Pushing a commit
- 30+ minutes of active editing
- A merged PR
- A successfully completed AI task
- (Test runs also feed activity detection)

**What doesn't count:** opening the app. Sitting idle. The streak measures
*doing*, not *showing up*.

**The safety nets:**
- **Streak Freeze** ❄️ — earn 1 per 7 streak days (max 3 banked). Miss a day?
  A freeze auto-burns and the streak survives. No guilt, no punishment.
- **Vacation Mode** 🏖️ — pause up to 14 days/year. Life happens; the streak
  waits for you.
- **At-risk nudges** — a gentle note (not a blaring alarm) if your streak is
  in danger after 6 PM. Celebration, never shame.

**The tangible reward — bonus quota:**
| Streak | Bonus AI requests/day |
|---|---|
| 7 days | +100 |
| 14 days | +200 |
| 30 days | +500 |

Bonuses **stack on top of** your plan limit (even paid plans). A Pro user on a
30-day streak gets 3,500 requests/day. Consistency literally buys compute.

**Two-mode UX (the anti-annoyance system):**
- *Passive mode* (you're just editing/reading): silent streak tracking, a tiny
  `🔥 N` in the status bar. No popups, no quests, no XP spam. Your flow is sacred.
- *Active mode* (you invoke an agent): the full experience unlocks — quests,
  achievements, progress UI, celebrations.

**Technical notes:** pure-logic module (no VS Code dependency, fully tested);
local-timezone day boundaries; storage at `~/.sunday/engagement/*.json`;
the gateway trusts the client's streak header in v1 (signed attestations planned).

*Roadmap (designed, not yet built): daily quests, 37 achievements, 7
proficiency ranks (Novice → Master), squads (up to 10, celebration-only),
weekly leagues (Bronze → Legendary).*

### 3.3 Zero-config AI — the onboarding breakthrough

The #1 killer of AI coding tools is setup friction: *"paste your API key here,
then configure your billing there…"* Sunday eliminates it:

1. Download the installer, run it.
2. Click "Continue with Google" (or GitHub/Microsoft).
3. You instantly have **200 free AI requests/day**. No keys, no cards, no config.

The OAuth token is exchanged server-side for a Sunday session; the gateway's
keys talk to OpenRouter/Groq; you just type. Power users can still bring their
own keys or point at a local Ollama instance.

### 3.4 Billing — India-first, Merchant-of-Record

**Provider: Paddle** (chosen over Cashfree/Razorpay after analysis — Paddle as
Merchant of Record handles all GST/tax globally, so there's zero tax-filing
burden).

| Tier | ₹/mo (GST-incl.) | Requests/day | Agents | Browser sessions |
|---|---|---|---|---|
| Free | ₹0 | 200 | 1 | — |
| Basic | ₹149 | 500 | 2 sequential | 5/day |
| Smart | ₹349 | 1,200 | 3 sequential | 15/day |
| Pro | ₹799 | 3,000 | 4 parallel | Unlimited |

UPI supported. Streak bonuses stack on top of every tier.

### 3.5 Updates — the auto-update promise

The IDE checks the gateway's `/updates/check` endpoint (silently in the
background, plus a manual Help → Check for Updates). The gateway reads
GitHub's releases list (10-min cache), normalizes beta tags
(`ide-v1.0.0-beta.N` → `1.0.0-beta.N`), and answers with the right binary for
your platform + channel. Beta users get betas; stable users never see a
prerelease. The installer is downloaded and handed to the OS installer —
per-user (`UserSetup`) by default so no admin rights are needed on Windows.

### 3.6 Trust & safety

- **Account-switch protection:** 2 distinct accounts per provider per machine
  per 24h stops free-tier farming; paid users exempt; re-login to the *same*
  account never counts.
- **Admin gateway:** separate allowlisted login, 8h sessions, refresh rotation,
  hashed audit logs. Admins bypass quota/switch limits but *not* webhook
  signatures.
- **Approval-first agents:** destructive actions require explicit approval;
  every change is diffable and revertible.

---

## 4. Sunday vs VS Code

### 4.1 Feature comparison

| Dimension | VS Code (+ Copilot) | Sunday |
|---|---|---|
| Editor core | The gold standard | **Identical** — it's a fork; every feature, extension, theme, keybinding works |
| AI entry point | Copilot: chat sidebar + inline completions (~$10/mo) | Agents built into the product; 200 req/day free |
| Agent autonomy | You drive; AI suggests | **Agents execute end-to-end**; you review |
| Multi-file changes | Manual or Copilot Edits (limited) | One instruction → coordinated multi-file refactor |
| Parallel agents | ❌ | ✅ Up to 4 (Pro) + Manager view |
| Browser control | Extensions only | ✅ Native Playwright agent |
| Scheduled agents | ❌ | ✅ Built-in scheduler |
| Gamification | ❌ | ✅ Streaks, freezes, bonus quota |
| Zero-config AI | ❌ (key + subscription setup) | ✅ Sign in → 200/day instantly |
| Extension marketplace | Proprietary Microsoft Marketplace | **Open VSX** (open-source) |
| License | Source-available, not OSI-approved | **Apache-2.0**, fully open |
| Price (India) | Free + $10/mo Copilot (~₹830) | Free tier usable; paid from **₹149/mo** |

### 4.2 Architecture comparison

| Dimension | VS Code | Sunday |
|---|---|---|
| Codebase | Microsoft's repo | Fork of VS Code 1.140.0, **zero `src/` changes** — config + branding + bundled extensions only |
| AI runtime | Copilot extension → GitHub's cloud | `sunday-agent` ext → local `sundayd` daemon → hosted gateway (or BYOK/Ollama) |
| Data folder | `.vscode` | `.sunday` (clean separation; both can coexist) |
| Update feed | Microsoft | Self-hosted via gateway `/updates/check` |
| Auth providers | Microsoft/GitHub | Google/GitHub/Microsoft + Sunday session layer |

### 4.3 The migration story

Because it's a fork with zero workbench-code changes, **everything you know
transfers**: settings sync format, `keybindings.json`, snippets, tasks,
launch configs, and the vast majority of extensions (via Open VSX or VSIX
sideload). Install Sunday alongside VS Code; they don't conflict.

**Bottom line:** Sunday is VS Code with the AI relationship inverted — from
*assistant that suggests* to *workforce that ships* — at 1/5th the price in
India, fully open source.

---

## 5. Sunday vs Google Antigravity

Antigravity (Google — announced Nov 2025 alongside Gemini 3, now "Antigravity
2.0") is the closest philosophical sibling: an **agent-first IDE** where AI
works across editor, terminal, and browser. This section is the honest,
researched comparison (pricing data current as of Oct 2026).

### 5.1 Head-to-head: capabilities

| Capability | Google Antigravity | Sunday | Notes |
|---|---|---|---|
| Agent-first architecture | ✅ Native | ✅ Native | Both built around autonomous agents, not completions |
| Cross-surface agents (editor+terminal+browser) | ✅ Deep Chrome integration | ✅ Playwright `browserd` | Antigravity's browser loop is more mature today |
| Parallel agents | ✅ Manager view, 5 agents | ✅ Manager view, 4 agents (Pro) | Near parity |
| Model choice | Gemini 3 Pro/Flash, Claude Sonnet/Opus, GPT-OSS | OpenRouter + Groq (open models); BYOK; Ollama | Antigravity's frontier models reason better; Sunday's are cheaper |
| SWE-bench Verified | **76.2%** (reported) | Not yet benchmarked | Antigravity leads on published evals |
| First-attempt task completion | ~72% (Gravity Mode, reported) | Unmeasured (beta) | — |
| Artifacts (plans, screenshots, recordings) | ✅ | ✅ | Both generate verifiable outputs |
| Knowledge base | ✅ Knowledge artifacts | ✅ Second Brain + learning loop | Same concept, different names |
| Visual iteration (screenshot → code) | ✅ Browser-in-the-loop | ✅ Design-to-code | Both close the mockup-to-code gap |
| Scheduled/background agents | ✅ | ✅ Scheduler | Parity |
| Gamification / streaks | ❌ | ✅ **Unique to Sunday** | No competitor does this |
| Vibe coding (NL → app) | ✅ Marketed heavily | ✅ Core workflow | Parity in concept |

### 5.2 Head-to-head: pricing (Oct 2026 data)

**Antigravity** (bundled with Google AI plans; free tier cut repeatedly since launch):

| Plan | $/mo | What you get |
|---|---|---|
| Free | $0 | ~20 agent requests/day, single-agent only (was 250/day at launch — cut 92%) |
| AI Pro | $20 | Baseline quota, parallel missions, browser agent |
| AI Ultra 5x | $100 | ~5× Pro quota |
| AI Ultra 20x | $200 | ~20× Pro quota |
| Credits (overage) | $25 / 2,500 | $0.01 each — overages only, no longer bundled |

Caveats from community reports: complex-model sessions get throttled harder
than advertised; a single Claude Opus session can burn 600+ credits; non-Gemini
models bill your own API key on top.

**Sunday:**

| Plan | ₹/mo | $ equiv | Requests/day | Agents |
|---|---|---|---|---|
| Free | ₹0 | $0 | **200** | 1 |
| Basic | ₹149 | ~$1.80 | 500 | 2 |
| Smart | ₹349 | ~$4.20 | 1,200 | 3 |
| Pro | ₹799 | ~$9.60 | 3,000 | 4 parallel |

**The pricing story in one line:** Sunday's *free* tier (200/day) is **10×**
Antigravity's free tier (20/day), and Sunday's *top* tier (₹799 ≈ $9.60)
costs **less than half** of Antigravity's *entry* paid tier ($20) — while
offering 3,000 requests/day.

### 5.3 Head-to-head: openness & control

| Dimension | Antigravity | Sunday |
|---|---|---|
| Source code | ❌ Proprietary (Google) | ✅ Apache-2.0 — every line auditable |
| Self-hosting | ❌ | ✅ Gateway is open; self-hostable |
| Vendor lock-in | Full (models, IDE, billing = Google) | None (BYOK, Ollama, Open VSX) |
| Data transparency | Google's privacy policy | Local-first design; gateway code is public |
| Community influence | Feature requests into a void | Open repo, open roadmap |

### 5.4 Head-to-head: strategic position

| Dimension | Antigravity | Sunday |
|---|---|---|
| Backing | Google — effectively infinite resources | Indie team, shipping fast |
| Model advantage | Gemini 3 frontier — best reasoning available | Good open models; the gap is real today |
| Distribution | Google's reach | Word of mouth + community |
| Geographic focus | Global, USD pricing | **India-first**: UPI, GST-inclusive INR, ₹149 entry |
| Maturity | Public preview → 2.0, large team | Beta, small team |
| Moat | Models + distribution | Openness + price + engagement |

### 5.5 The honest verdict

**Choose Antigravity if:** you want the smartest available models (Gemini 3),
you trust Google's infrastructure, you need published benchmark confidence
today, and $20–200/mo fits your budget.

**Choose Sunday if:** you want to *own* your tools (Apache-2.0, auditable,
self-hostable), you're price-sensitive (especially in India — ₹149 vs $20 is
not close), you like the idea of streaks that literally earn you free compute,
and you believe the future of dev tools is open.

**Sunday's thesis, stated plainly:** frontier models are rapidly commoditizing
— today's Gemini 3 lead is tomorrow's open-weights baseline. What *doesn't*
commoditize: trust (open source), price (₹149/mo), and the daily habit loop
(streaks). Sunday is betting the next billion developers care more about those
three than about a few SWE-bench points.

---

## 6. Business Model & Pricing

- **Revenue:** Paddle subscriptions (Merchant of Record — handles GST/tax
  worldwide; zero filing burden). UPI supported for India.
- **Free tier as acquisition:** 200 req/day free is deliberately generous
  (10× Antigravity's) — the funnel is *install → streak → habit → upgrade*,
  not *paywall → churn*.
- **Streaks as retention + monetization:** bonus quota rewards consistency;
  heavy users naturally graduate to paid tiers for parallel agents and
  unlimited browser sessions.
- **Costs:** inference via OpenRouter/Groq free-tier and negotiated rates;
  gateway on Render; CI on GitHub Actions (free for public repos).
- **What billing needs:** Paddle account → products → API keys → webhook
  secrets → sandbox test → live. (Implementation deferred by founder decision;
  architecture documented in `docs/PAYMENT_ARCHITECTURE.md`.)

---

## 7. Roadmap & Status

### ✅ Shipped (Beta.1)

Everything in §3: agents, parallel execution, swarm, browser agent, scheduler,
streaks + bonus quota, zero-config auth, account protection, admin gateway,
auto-update with beta channel, Open VSX gallery, usage dashboard.

### 🔬 Verifying

- Real-world Windows auto-update end-to-end
- Streak bonus quota applied to managed IDE sessions
- Admin sign-in in a production IDE build

### 📋 Designed, not yet built

- **Engagement E.2–E.5:** daily quests, 37 achievements, 7 ranks
  (Novice → Master), squads, weekly leagues
- **Paddle billing implementation** (founder-deferred)
- **Postgres migration** for gateway storage (currently JSON files)
- **Signed streak attestations** (server-side trust hardening)
- **npm:** `@sunday/cli` publication

### 🔭 Longer-term

- SWE-bench Verified evaluation + published scores
- JetBrains plugin (Kotlin prototype exists)
- Self-hosted gateway one-click deploy
- Team/organization plans

---

*Built with ❤️ in India. Sunday is Apache-2.0 open source —
[github.com/Vivek492005/Sunday](https://github.com/Vivek492005/Sunday).
Contributions welcome.*
