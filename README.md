<p align="center">
  <img src="branding/sunday-logo.jpg" alt="Sunday logo" width="128" />
</p>

# Sunday — The Agent-First Coding IDE

> **Your AI pair programmer, built into your editor.** Sunday is a VS Code-based IDE with a built-in autonomous coding agent — not a chatbot bolted on, but an agent-first development environment.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Vivek492005/Sunday)](https://github.com/Vivek492005/Sunday/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/Vivek492005/Sunday/sunday-ide.yml?branch=main&label=IDE%20build)](https://github.com/Vivek492005/Sunday/actions)

🎬 **Watch:** [Sunday Promo Video (2 min)](https://github.com/Vivek492005/Sunday/releases/download/v1.0.0-beta.1/sunday-promo-2min.mp4)

![Sunday demo](https://github.com/Vivek492005/Sunday/releases/download/v1.0.0-beta.1/sunday-demo.gif)

---

## Contents

- [What is Sunday?](#what-is-sunday)
- [✨ Features](#-features)
- [🚀 Quick Start](#-quick-start)
- [⚙️ Configuration](#-configuration)
- [📦 Package Layout](#-package-layout)
- [🛠️ Develop](#️-develop)
- [📚 Documentation](#-documentation)
- [🗺️ Roadmap](#️-roadmap)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)
- [🙏 Acknowledgments](#-acknowledgments)

---

## What is Sunday?

Sunday takes the editor you already know — VS Code — and rebuilds it around an **autonomous coding agent**. Instead of copying code from a chat window, you describe what you want and Sunday's agent:

1. **Plans** the change (breaking it into steps)
2. **Reads** your codebase (with semantic context retrieval)
3. **Edits** files (with diff review before anything is applied)
4. **Runs** terminal commands (with your approval)
5. **Verifies** the result (with a built-in verifier agent)
6. **Checkpoints** everything (shadow-git lets you undo any hunk)

### How it works

```
┌─────────────────────────────────────────────────────────────┐
│                    Sunday IDE (VS Code fork)                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Chat View   │  │ Agent Manager│  │  Agent Browser   │  │
│  │  (ui-chat)   │  │ (ui-manager) │  │   (live view)    │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         └────────────────┼───────────────────┘            │
│              sunday-agent extension (ext-agent)             │
└──────────────────────────┼──────────────────────────────────┘
                           │ JSON-RPC (NDJSON)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              sundayd — per-user daemon (sundayd)             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ Sessions │ │ Agent    │ │ Policy   │ │ Orchestrator   │  │
│  │          │ │ Loop     │ │ Gate     │ │ (multi-agent)  │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ Tools    │ │ Context  │ │ MCP Hub  │ │ Checkpoints    │  │
│  │ (fs,git, │ │ (TF-IDF  │ │ Skills   │ │ (shadow-git)   │  │
│  │ terminal)│ │ retrieval)│ │          │ │                │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────────────┐
│           Gateway — provider router (gateway)               │
│     OpenRouter ◄──► Groq  │  Relay fallback on 429/quota   │
└─────────────────────────────────────────────────────────────┘
```

**Key design principles:**
- **API-first, no local model loading** — uses OpenRouter + Groq (free tiers available); your machine stays light
- **One daemon per user** — shared socket, single-flight startup, per-workspace isolation
- **Fail-closed security** — untrusted workspaces get restricted tools, secrets never leave your machine unredacted
- **Visible Relay** — when a provider rate-limits, you see exactly what happened and it auto-resumes

---

## ✨ Features

### 🆓 Zero-Config Free Tier
- **No API keys needed** — sign in with Google, get **200 free AI requests/day**
- **Hosted gateway** — [sunday-final-ide.onrender.com](https://sunday-final-ide.onrender.com) serves free open models
- **BYOK always available** — bring your own OpenRouter/Groq keys for unlimited use
- **Local-first** — BYOK and local routes work fully offline, no account needed

### 🧠 Second Brain Memory
- **Automatic memory extraction** — the agent remembers your preferences, decisions, and project context across sessions
- **Semantic search** — recall anything with natural language queries
- **Cross-project learning** — apply learnings from one project to another
- **Privacy-first** — stored locally in `~/.sunday/memory/`, secrets never memorized

### 🔄 Self-Improving Agent
- **Learns from corrections** — when you fix the agent, it extracts a reusable rule
- **Rules engine** — learned rules are injected into every future session
- **Rules view** — browse, edit, and manage learned rules

### 👥 One-Prompt Swarm
- **Decompose any task** — one prompt becomes a Kanban board of parallel subtasks
- **Live Kanban UI** — watch subtasks move from queued → running → done
- **Stop-all** — kill the entire swarm with one click

### 🔮 Proactive Mode
- **Opt-in idle detection** — when you're away, the agent investigates failing tests and open issues
- **Audit log** — every proactive action is logged for your review
- **Your control** — enable/disable anytime, nothing runs without your permission

### ☁️ Cloud Async Tasks
- **Fire and forget** — submit a task, get notified when it's done
- **Background execution** — runs via sundayd even with the IDE minimized

### 🎯 Best-of-N Attempts
- **Multiple solutions** — the agent tries N approaches in parallel (varied temperatures and strategies)
- **Comparison view** — pick the winner from a side-by-side diff

### 🎨 Artifacts
- **Interactive output** — agents create live HTML previews, diagrams (Mermaid), and documents
- **Sandboxed rendering** — safe iframe isolation for HTML artifacts

### 🎛️ Mission Control
- **Fleet dashboard** — all running agents in one view: orchestration runs, browser sessions, cloud tasks, scheduled tasks
- **Live status** — 2-second refresh, log tails, Stop/Restart controls

### ⏰ Scheduled Tasks
- **Cron for agents** — "every morning at 9am, check test health and report"
- **Overlap protection** — skips runs that would collide with in-flight work

### 📋 AGENTS.md Support
- **Repo-level instructions** — drop an `AGENTS.md` in your repo root; the agent always follows it
- **Per-directory overrides** — nearest AGENTS.md wins

### 🎨 Style Inference
- **Learns your code style** — indent, quotes, naming conventions from your existing code
- **Auto-applied** — generated code matches your project's style

### 📦 Project Templates
- **One-command scaffolding** — `sunday.initProject` with React+TS, Node API, Python CLI, Next.js templates

### 🎭 Agent Modes
- **Architect** — read-only planning mode
- **Implementer** — full execution mode
- **Reviewer** — read + critique, no writes

### 🔀 PR Automation
- **End-to-end PRs** — agent creates branch, commits, pushes, and opens a PR with generated description
- **Review handling** — fetches review comments for the agent to address

### 🎨 Design-to-Code
- **Image to component** — paste a design screenshot, get framework-matched code (auto-detects React/Vue/etc.)
- **Diff preview** — review before applying

### 🧙 Repo Onboarding Wizard
- **One-command setup** — detects stack, installs deps, creates `.env`, runs dev server
- **Checklist UI** — visual progress through each setup step

### ⌨️ Terminal Command Generation
- **Natural language to shell** — describe what you want, get a safe command (always approval-gated)

### 🗣️ Voice Input
- **Speak your prompt** — microphone input via Web Speech API in the chat panel

### 📊 Usage Dashboard
- **Track your consumption** — per-model token usage, 7-day history, daily limits
- **Inline SVG charts** — no external dependencies

### 🔄 Auto-Update
- **Check for Updates** — in the Help menu, plus automatic check on startup
- **One-click install** — download and launch the installer; no manual re-download needed

### 🤖 Autonomous Agent
- **Multi-step task execution** — describe a feature, the agent plans, codes, and verifies
- **Hierarchical orchestration** — Orchestrator breaks work into parallel units → Feature Agents execute → Verifier checks (max 8 units, overlap detection, budget enforcement)
- **Checkpointing** — shadow-git gives hunk-level undo for every agent change

### 🧠 Editor Intelligence
- **Ghost-text autocomplete** — Tab to accept, powered by fast/cheap models
- **Inline edit** (`Ctrl+I`) — select code, describe the change, review the diff
- **Code actions** — Fix, Explain, Generate Tests
- **Smart mentions** — `@file`, `@folder`, `@symbol`, `@selection`, `@terminal`, `@diagnostics`, `@git-diff`, `@web`, `@docs`
- **Next-edit suggestions** — after a rename, offers the next occurrence as CodeLens *(experimental)*
- **Commit message generation** — from your staged diff

### 🌐 Agent Browser
- **Live browser view** — watch the agent browse (2fps screencast)
- **Takeover mode** — grab control mid-task, hand it back when done (pauses screencast for privacy)
- **13 `browser_*` tools** — navigation, snapshots, console, screenshots, walkthroughs
- **Policy-gated** — `file://` and private IPs blocked, new origins need approval

### 🔧 Developer Tools
- **MCP support** — Model Context Protocol servers (stdio + HTTP), namespaced tools
- **Skills system** — reusable prompt + script bundles with trust gating, plus community marketplace
- **Terminal integration** — run commands with approval, auto-explain errors
- **Git integration** — status, diff, log, commit generation
- **Session sync** — end-to-end encrypted session backup across devices (opt-in)

### 💻 Multiple Frontends
| Frontend | Status | Description |
|----------|--------|-------------|
| **VS Code extension** | ✅ Stable | Full IDE experience (this repo's primary target) |
| **Sunday IDE** | ✅ Beta | Branded VS Code fork (Windows/Linux/macOS) — v1.0.0-beta.1 |
| **CLI** (`sunday`) | ✅ Stable | `sunday chat`, `sunday status`, `sunday sessions` |
| **JetBrains plugin** | 🔄 In progress | IntelliJ Platform plugin (Kotlin) |
| **Hosted gateway** | ✅ Live | OpenAI-compatible API, free tier (200 req/day) |

---

## 🚀 Quick Start

### Option 1: Sunday IDE (recommended) — 1.0.0-beta.1

Download the full IDE from the [1.0.0-beta.1 release](https://github.com/Vivek492005/Sunday/releases/tag/v1.0.0-beta.1):

| Platform | Download |
|----------|----------|
| Windows | `SundaySetup-x64-1.0.0-beta.1.exe` (system) or `SundayUserSetup-x64-1.0.0-beta.1.exe` (user) |
| macOS (ARM64) | Sunday DMG installer |
| Linux (x64) | Sunday tarball |

**No API keys needed to start!** Open Sunday → click **Sign in with Google** → get **200 free AI requests/day** via the Sunday hosted gateway. That's it.

> **🔄 Staying updated:** Sunday checks for updates automatically on startup. You can also check manually via **Help → Check for Updates**. When a new version is available, one click downloads and installs it — no manual re-download needed.

<details>
<summary><b>Prefer your own API keys? (BYOK)</b></summary>

```sh
# Get free keys from:
# - OpenRouter: https://openrouter.ai/keys
# - Groq: https://console.groq.com/keys
export OPENROUTER_API_KEY="sk-or-..."
export GROQ_API_KEY="gsk_..."
```

BYOK routes work fully offline with no account required.
</details>

### Option 2: VS Code Extension

1. Download `sunday-agent-1.0.0-beta.1.vsix` from the [releases page](https://github.com/Vivek492005/Sunday/releases/tag/v1.0.0-beta.1)
2. Install: `code --install-extension sunday-agent-1.0.0-beta.1.vsix`
3. Set your API keys (see above)
4. Open VS Code → Sunday Chat view → start building!

### Option 3: CLI Only

```sh
# Build from source (see Develop section)
pnpm --filter @sunday/cli build

# Chat with the agent
sunday chat "refactor the auth module to use JWT"

# Check daemon status
sunday status

# List sessions
sunday sessions
```

---

## ⚙️ Configuration

All settings live under `sunday.*` in VS Code settings (or env vars for CLI):

### Core

| Setting | Default | Description |
|---------|---------|-------------|
| `sunday.provider.order` | `["openrouter", "groq"]` | Provider failover order |
| `sunday.model.default` | `"openrouter:anthropic/claude-3.5-sonnet"` | Default chat model |
| `sunday.model.completion` | `"groq:llama-3.1-8b-instant"` | Fast model for autocomplete |
| `sunday.daemon.idleTimeoutMinutes` | `30` | Daemon idle shutdown (0 = disabled) |
| `sunday.sandbox.mode` | `"off"` | `off` / `docker` / `bubblewrap` |

### Features (experimental)

| Setting | Default | Description |
|---------|---------|-------------|
| `sunday.nextEdit.enabled` | `false` | Next-edit CodeLens suggestions |
| `sunday.backgroundAgents.enabled` | `false` | Detached background runs → PRs |
| `sunday.voice.inputEnabled` | `false` | Microphone input |
| `sunday.voice.outputEnabled` | `false` | Spoken responses |
| `sunday.browser.enabled` | `false` | Agent browser tools |
| `sunday.orchestration.parallel` | `false` | Multi-agent parallel execution |

### Environment Variables

```sh
OPENROUTER_API_KEY="sk-or-..."    # OpenRouter API key
GROQ_API_KEY="gsk_..."            # Groq API key
SUNDAY_DAEMON_IDLE_TIMEOUT_MINUTES="30"  # Override idle timeout
```

> **🔒 Security note:** API keys are read from environment variables only — never from config files. See [docs/SECURITY.md](docs/SECURITY.md).

---

## 📦 Package Layout

This is a pnpm monorepo. Each package is independently versioned and tested.

### Core Agent Stack

| Package | Description | Tests |
|---------|-------------|-------|
| `packages/protocol` | Shared types, JSON-RPC schemas (zod), versioned protocol | 18/18 |
| `packages/gateway` | Provider adapters (OpenRouter, Groq), router, Relay fallback, rate-limit scheduler | 49/49 |
| `packages/sundayd` | The daemon: sessions, agent loop, policy gate, checkpoints, orchestration host | 261/261 |
| `packages/tools` | Tool implementations: `read_file`, `write_file`, `edit_file`, `run_terminal`, git tools | — |
| `packages/context` | Repo map, code chunker, TF-IDF retrieval | — |
| `packages/orchestrator` | Hierarchical multi-agent: plan validation, budget, verifier | 72/72 |

### Intelligence & Capabilities

| Package | Description | Tests |
|---------|-------------|-------|
| `packages/mcp` | Model Context Protocol hub (stdio + Streamable HTTP) | 26/26 |
| `packages/skills` | Skills loader, rule engine, memory with secret refusal | 58/58 |
| `packages/browserd` | Managed browser child process + `browser_*` tools | — |

### Frontends

| Package | Description | Tests |
|---------|-------------|-------|
| `packages/ext-agent` | VS Code extension (esbuild bundle): chat, manager, browser views | 286/286 |
| `packages/ui-chat` | React chat webview | 58/58 |
| `packages/ui-manager` | React Agent Manager webview | — |
| `packages/sunday-cli` | Terminal frontend (`sunday chat/status/sessions`) | 14/14 |
| `packages/jetbrains-plugin` | IntelliJ Platform plugin (Kotlin, Gradle) | 19 (JUnit) |
| `packages/hosted-gateway` | OpenAI-compatible API server with abuse controls | 44/44 |

### Infrastructure

| Package | Description |
|---------|-------------|
| `packages/eval` | Benchmark harness: 14 tasks, fake + live adapters |
| `vscode/` | Vendored VS Code 1.140.0 source (for IDE fork builds) |
| `scripts/` | Build, packaging, and verification scripts |
| `docs/` | Architecture, security, eval, and guides |

**Total: ~1,885 tests**, all passing. See [docs/PROJECT_BLUEPRINT.md](docs/PROJECT_BLUEPRINT.md) for the full phase-by-phase breakdown.

---

## 🛠️ Develop

### Prerequisites

- **Node.js** ≥ 22
- **pnpm** ≥ 10
- **Git**

### Setup

```sh
# Clone
git clone https://github.com/Vivek492005/Sunday.git
cd Sunday

# Install (frozen lockfile for reproducibility)
pnpm install --frozen-lockfile

# Build all packages (sequential — parallel tsc OOMs on small VMs)
pnpm -r --workspace-concurrency=1 build

# Test all packages
pnpm -r --workspace-concurrency=1 test
```

### Running the Eval Benchmark

```sh
# Fake-scripted baseline (no API keys needed)
pnpm --filter @sunday/eval eval

# Live-model baseline (needs OPENROUTER_API_KEY or GROQ_API_KEY)
pnpm --filter @sunday/eval eval:live-baseline
```

### Project Conventions

- **Zero `vscode/` changes** — the vendored VS Code tree is upstream code; all Sunday changes live in `packages/` with `// SUNDAY(P-xxx)` markers where they touch the fork build
- **Sequential builds** — `pnpm -r --workspace-concurrency=1` (parallel OOMs on 2-vCPU VMs)
- **API-first** — no local model loading; Ollama is roadmap, not default
- **One-time PATs** — GitHub tokens are used once via env vars, never stored

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## 📚 Documentation

| Doc | Description |
|-----|-------------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flow, component boundaries |
| [docs/adr/](docs/adr/) | Architecture Decision Records — why each major choice was made |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Project vocabulary defined in one place |
| [docs/FAQ.md](docs/FAQ.md) | Common questions: privacy, local models, vs Copilot/Cursor |
| [docs/PROJECT_BLUEPRINT.md](docs/PROJECT_BLUEPRINT.md) | Complete phase-by-phase project history |
| [docs/PHASE8.md](docs/PHASE8.md) | Phase 8 features in detail |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, security practices |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | STRIDE-lite analysis, 12 findings |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Data handling, local-only mode |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Benchmarks, soak test methodology |
| [docs/EVAL.md](docs/EVAL.md) | Eval harness, pass targets |
| [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) | A11y audit + human test checklist |
| [docs/PHASE8_DAEMON_PLAN.md](docs/PHASE8_DAEMON_PLAN.md) | Daemon lifecycle, autostart, idle shutdown |
| [docs/RELEASE_GATES.md](docs/RELEASE_GATES.md) | 1.0-beta release gate tracking |
| [docs/BETA_RELEASE_CHECKLIST.md](docs/BETA_RELEASE_CHECKLIST.md) | Beta release procedure |
| [docs/UPGRADE.md](docs/UPGRADE.md) | Upstream VS Code upgrade runbook |
| [docs/NAMING.md](docs/NAMING.md) | AURORA → SUNDAY rename mapping |

---

## 🗺️ Roadmap

### 1.0.0-beta.1 (shipped ✅)
- [x] 8/11 release gates with concrete evidence
- [x] Build gate — CI green on 3 platforms (Linux, macOS, Windows)
- [x] Full IDE installers (Windows/macOS/Linux)
- [x] Zero-config free tier — hosted gateway live, Google sign-in, 200 req/day
- [x] 5 productivity features — Second Brain, Self-Improving Agent, Swarm UI, Proactive Mode
- [x] 18 competitive features — artifacts, mission control, best-of-N, AGENTS.md, and more
- [x] Auto-update — Check for Updates + one-click install
- [x] Accounts & entitlements — Basic/Smart/Pro plan foundation (Phase 9.a/9.b)
- [x] P0 + P1 security hardening
- [ ] Accessibility gate — human screen-reader sign-off (pending)
- [ ] Human verification steps (pcap, soak, live eval, QA ritual)

### 1.0 (planned)
- [ ] Beta feedback incorporation
- [ ] JetBrains plugin compile + publish
- [ ] Daemon Stage 4 re-implementation (idle shutdown, autostart)
- [ ] Installer code signing
- [ ] Terms of Service + Privacy Policy published

### Future (on demand signal)
- [ ] Billing integration — Paddle checkout, Smart/Pro subscriptions (Phase 9.c)
- [ ] Managed model gateway — paid provider routes (Phase 9.d)
- [ ] Ollama local model support (optional, not default)
- [ ] Next-edit LLM re-ranker (currently heuristic)

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Code style and conventions
- How to run tests
- How to submit PRs
- The `// SUNDAY(P-xxx)` patch marker system

---

## 📄 License

Apache-2.0 — see [LICENSE](LICENSE). Copyright (c) 2026 Sunday.

The vendored `vscode/` tree retains its upstream MIT license (Microsoft). See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

## 🙏 Acknowledgments

Built on the shoulders of giants:
- [VS Code](https://github.com/microsoft/vscode) — the editor foundation (MIT)
- [VSCodium](https://github.com/VSCodium/vscodium) — inspiration for the fork build approach
- [OpenRouter](https://openrouter.ai) & [Groq](https://groq.com) — model providers

---

<p align="center">
  <b>☀️ Sunday</b> — <i>Build at the speed of thought.</i>
</p>
