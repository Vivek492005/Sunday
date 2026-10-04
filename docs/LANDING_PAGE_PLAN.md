# ☀️ Sunday Landing Page — Plan

**Purpose:** A deployable marketing landing page for Sunday (the agent-first coding IDE) — built for easy sharing and access: one URL that explains what Sunday is, shows it in action, and gets people downloading in under 60 seconds.

**Status:** PLAN ONLY — no site code written yet. This document is the complete build spec for whoever implements it.

**Source of truth for copy:** [`README.md`](../README.md), [`docs/PROJECT_BLUEPRINT.md`](PROJECT_BLUEPRINT.md), [`docs/RELEASE_NOTES_1.0-BETA.md`](RELEASE_NOTES_1.0-BETA.md).

---

## 1. Page Structure (section by section)

### 1.1 Nav — sticky top bar

| Aspect | Spec |
|---|---|
| **Purpose** | Persistent navigation + primary conversion CTA |
| **Content** | Logo (☀️ + "Sunday" wordmark) · Links: Features, How it works, Docs, GitHub · CTA button: **"Get Sunday"** → `#download` |
| **Visual** | Glassmorphism bar (`backdrop-filter: blur(16px)`, `rgba(10,10,15,0.6)`), hairline bottom border (`1px solid rgba(255,255,255,0.08)`). Logo glows subtly on hover. Shrinks padding on scroll (JS class toggle). |
| **Interactive** | Smooth-scroll anchor links. Mobile: hamburger → full-screen overlay menu. GitHub link shows live star count via `api.github.com` (cached, non-blocking). |

---

### 1.2 Hero — first viewport

| Aspect | Spec |
|---|---|
| **Purpose** | 5-second comprehension + conversion. Visitor must leave knowing: *Sunday = VS Code rebuilt around an autonomous coding agent, free, open source.* |
| **Headline** | `Your editor, with an agent inside.` |
| **Subheadline** | `Sunday is a VS Code-based IDE rebuilt around an autonomous coding agent. Describe the feature — it plans, codes, tests, and verifies. You review the diff.` |
| **CTAs** | Primary: **"Download for Windows"** → `#download` (glossy sunrise-gradient button with glow). Secondary: **"See how it works"** → `#how-it-works` (ghost button, hairline border). Tertiary link: `v0.1.0 dev preview · Apache-2.0` → `#download`. |
| **Visual** | Full-viewport. Animated **gradient-mesh background** (3–4 blurred radial blobs in amber/orange/cyan drifting slowly, CSS keyframes, `prefers-reduced-motion` respected). Subtle **particle canvas** (JS, ~80 particles, additive blend, pauses offscreen via IntersectionObserver). Foreground: floating **product screenshot in a 3D-tilted browser/editor frame** (mouse-parallax tilt, max 8°, `transform-style: preserve-3d`), with glow shadow. Headline uses display font at `clamp(2.75rem, 7vw, 5.5rem)`, tight leading, with a **sunrise gradient on the words "an agent"**. |
| **Interactive** | Typing animation under CTAs cycling through real prompts: `sunday chat "add JWT auth to the login route"` → `sunday chat "find the N+1 query and fix it"` → `sunday chat "write tests for the checkout flow"`. Mouse parallax on the screenshot. Scroll indicator arrow. |
| **Copy notes** | Technical, confident, no hype. Never claim "10x". Never say "done/live" about unreleased things. |

---

### 1.3 Logos / Social proof strip

| Aspect | Spec |
|---|---|
| **Purpose** | Credibility in one glance. |
| **Content** | `Built on VS Code 1.140.0` badge + stat counters (animated count-up on scroll into view): **~1,013 tests passing** · **16 packages** · **14-task eval benchmark** · **Apache-2.0 licensed**. |
| **Visual** | Single-row strip, dimmed monochrome badges, hairline dividers. Counters use mono font with sunrise-gradient numerals. |
| **Interactive** | Count-up animation triggered by IntersectionObserver, runs once. |

---

### 1.4 Features grid — 6 cards

| Aspect | Spec |
|---|---|
| **Purpose** | The "what can it do" answer. |
| **Cards** | 1. **🤖 Autonomous Agent** — *Describe the feature. The agent plans, reads your codebase, edits files, runs commands, and verifies — with hunk-level undo on everything.* 2. **🧠 Editor Intelligence** — *Ghost-text autocomplete, Ctrl+I inline edits, Fix/Explain/Tests actions, and `@file @symbol @terminal` mentions that actually understand context.* 3. **🌐 Agent Browser** — *Watch the agent browse in a live view. Take over mid-task, hand control back when done. Policy-gated: private IPs blocked, new origins need approval.* 4. **👥 Parallel Agents** — *Orchestrator splits work into parallel units → feature agents execute → verifier checks. Overlap detection, budgets, no conflicts.* 5. **🔒 Fail-closed Security** — *Untrusted workspaces get restricted tools automatically. Secrets are redacted before they ever reach history or logs. Keys live in env vars, never config files.* 6. **💻 Your Workflow, Your Way** — *VS Code extension, terminal CLI, JetBrains plugin, or a hosted OpenAI-compatible API. One daemon per user, shared across all of them.* |
| **Visual** | 3×2 grid (1-col on mobile). Glassmorphism cards (`rgba(255,255,255,0.04)`, 1px gradient border via `border-image` or wrapper). **3D tilt on hover** (subtle, 4°) + border glow intensifies + icon lifts. Scroll-triggered stagger reveal (`translateY(24px)` → 0, 80ms stagger). |
| **Interactive** | Hover tilt + glow. Each card links to the relevant doc (`docs/ARCHITECTURE.md`, `docs/SECURITY.md`, etc.). |

---

### 1.5 How it works — 3-step animated diagram

| Aspect | Spec |
|---|---|
| **Purpose** | Make the agent loop tangible. |
| **Steps** | **1. Describe** — *Type a task in chat, or speak it. `@` mention the files that matter.* → **2. Agent works** — *It plans the change, reads code with semantic retrieval, edits with your approval, runs tests.* → **3. Review & merge** — *Inspect the diff, undo any hunk, accept. Background agents deliver as GitHub PRs.* |
| **Visual** | Horizontal 3-node flow on desktop (vertical on mobile). Nodes are glowing pills connected by an **animated dashed line** (SVG `stroke-dashoffset` animation, flowing left→right). Each node has a small looping visual: (1) typing cursor, (2) rotating gear / streaming tokens, (3) diff with green/red hunks. |
| **Interactive** | Auto-advances a highlight pulse through the 3 steps every 4s; hovering a step pauses and shows its detail text. `prefers-reduced-motion` → static. |

---

### 1.6 Interactive demo — terminal/chat mockup

| Aspect | Spec |
|---|---|
| **Purpose** | "Show, don't tell" — the closest thing to trying it without installing. |
| **Content** | A mock terminal window running a scripted demo: `$ sunday chat "add rate limiting to the API"` → agent streams: `Planning… (3 steps)` → `Reading src/api/routes.ts` → `Editing src/api/middleware.ts` → `✓ Tests pass (12/12)` → `Diff ready for review`. Then a mock diff view appears with `+`/`-` lines. |
| **Visual** | macOS-style window chrome (three dots), `JetBrains Mono`, cyan prompt, amber agent lines, green checkmarks. **Typing animation** (variable speed, faster for code). Blinking cursor. |
| **Interactive** | **Replay button.** Tabs to switch: `Terminal` / `Diff view` / `Chat UI`. Auto-plays once when scrolled into view; replay on click. Pure CSS/JS — no backend. |

---

### 1.7 Architecture — visual diagram

| Aspect | Spec |
|---|---|
| **Purpose** | Credibility for technical visitors; shows this is real engineering, not a wrapper. |
| **Content** | Layered diagram: **Sunday IDE / VS Code extension** → (JSON-RPC/NDJSON) → **sundayd daemon** *(sessions · agent loop · policy gate · orchestrator · MCP hub · checkpoints)* → (HTTPS) → **Gateway router** → **OpenRouter / Groq** *(Relay fallback on 429)*. Side annotations: *"One daemon per OS user"* · *"Keys in env vars only"* · *"Fail-closed policy gate"*. |
| **Visual** | Dark cards with glowing connectors; animated packet dots traveling along the connectors (CSS/SVG animation). Sunrise gradient on the daemon layer (the heart). |
| **Interactive** | Hovering a layer highlights it and shows a 1-line description tooltip. "Read the architecture doc →" link to `docs/ARCHITECTURE.md`. |

---

### 1.8 Code showcase — agent in action

| Aspect | Spec |
|---|---|
| **Purpose** | Show the *output* quality: a real-feeling agent turn. |
| **Content** | Two side-by-side code blocks (tabbed: `middleware.ts` / `middleware.test.ts`): left = diff of what the agent changed (unified diff with `+`/`-`), right = the test run output (`✓ 12 passed`). Caption: *"Actual output shape from the Sunday eval harness — 14 benchmark tasks, 100% tool reliability target."* |
| **Visual** | Syntax highlighting (Shiki or highlight.js, GitHub-dark-ish theme tinted to brand). Diff lines with green/red gutters. Copy button per block. |
| **Interactive** | Tab switcher, copy-to-clipboard with "Copied ✓" feedback. |

---

### 1.9 Use cases — 3 cards

| Aspect | Spec |
|---|---|
| **Purpose** | Help visitors self-identify. (No fake testimonials — these are persona cards, honestly labeled.) |
| **Cards** | 1. **Solo developer** — *"Ship the side project. Describe features in plain language; Sunday handles the boilerplate, tests, and refactors while you steer."* 2. **Team** — *"Parallel agents split a feature into independent units with overlap detection and a verifier gate — like a tireless junior team with a senior reviewing."* 3. **Student / learner** — *"Free-tier friendly (OpenRouter + Groq free tiers). Ask 'explain this function' on any selection; get Fix/Explain/Tests actions inline."* |
| **Visual** | Same glass-card system as features, with persona glyph (👤/👥/🎓). |
| **Interactive** | Hover lift. No fake quotes, no stock photos. |

---

### 1.10 Editions — pricing

| Aspect | Spec |
|---|---|
| **Purpose** | Answer "what does it cost" in 5 seconds. |
| **Content** | Single highlighted card: **Sunday — Free & Open Source**. *Apache-2.0. Every feature, every package. Bring your own API keys (OpenRouter and Groq both have free tiers).* Secondary note card: **Hosted gateway** — *Optional OpenAI-compatible API server with abuse controls, for users without their own provider keys. Self-host it — the code is in the repo.* Price shown: **$0** in big gradient numerals. CTA: "Download free →". |
| **Visual** | One wide glowing card (sunrise border), $0 huge. No fake tiers, no "Pro" upsell that doesn't exist. |
| **Interactive** | None needed beyond CTA. |

---

### 1.11 Download — conversion section

| Aspect | Spec |
|---|---|
| **Purpose** | The actual handoff: get the bits. |
| **Content** | Version badge `v0.1.0 dev preview`. Three download cards: **🪟 Windows installer** — `Sunday-Agent-Setup-0.1.0.exe` *(primary, highlighted)* · **🧩 VSIX** — `sunday-agent-0.1.0.vsix` + `code --install-extension` snippet with copy button · **⌨️ CLI / source** — `git clone` + `pnpm install` snippet. Below: SHA256 checksums (collapsible `<details>`), and the 4-step API-key setup (`export OPENROUTER_API_KEY=…`). Link: *"Full install guide → docs/INSTALL.md"*. |
| **Visual** | Download cards with platform glyphs, file sizes, and hover glow. Windows card has the sunrise gradient border (recommended). |
| **Interactive** | Copy buttons on all commands. OS auto-detect highlights the matching card via JS (`navigator.platform`). |

> **Note:** Asset URLs must point at the real GitHub release: `https://github.com/Vivek492005/Sunday/releases/tag/v0.1.0`. Do not invent URLs.

---

### 1.12 Docs links — 4 cards

| Aspect | Spec |
|---|---|
| **Purpose** | Route technical visitors deeper. |
| **Cards** | **Architecture** → `docs/ARCHITECTURE.md` · **Security** → `docs/SECURITY.md` · **Project blueprint** → `docs/PROJECT_BLUEPRINT.md` · **Contributing** → `CONTRIBUTING.md`. Each with a 1-line description. |
| **Visual** | Compact horizontal cards, doc glyph (📄), arrow on hover. |
| **Interactive** | Hover slide arrow. Links go to GitHub (rendered markdown) until docs are hosted. |

---

### 1.13 Footer

| Aspect | Spec |
|---|---|
| **Content** | Columns: **Product** (Features, Download, Roadmap) · **Resources** (Docs, Architecture, Security, Changelog) · **Community** (GitHub, Issues, Discussions). Bottom row: `© 2026 Sunday · Apache-2.0` · `Built on VS Code 1.140.0 (MIT)` · *"☀️ Build at the speed of thought."* |
| **Visual** | Dim, minimal, hairline top border. No clutter. |

---

## 2. Design System

### 2.1 Color palette

| Token | Value | Usage |
|---|---|---|
| `--bg-0` | `#0a0a0f` | Page background (near-black, blue-tinted) |
| `--bg-1` | `#101018` | Section alt background |
| `--surface` | `rgba(255,255,255,0.04)` | Glass cards |
| `--text-1` | `#f2f0ea` | Headings (warm white) |
| `--text-2` | `#a8a6a0` | Body (warm gray) |
| `--text-3` | `#6b6a66` | Muted / captions |
| `--sun-1` | `#ff6b35` | Sunrise gradient start (burnt orange) |
| `--sun-2` | `#f7c548` | Sunrise gradient mid (amber) |
| `--sun-3` | `#ffdd44` | Sunrise gradient end (radiant yellow) |
| `--neon` | `#00f0ff` | Code accents, terminal prompt (cyan) |
| `--ok` | `#3ddc84` | Success / passing tests |
| `--err` | `#ff5470` | Errors / diff deletions |
| `--line` | `rgba(255,255,255,0.08)` | Hairlines / borders |

**Gradient (brand):** `linear-gradient(135deg, #ff6b35, #f7c548 55%, #ffdd44)` — used for primary CTAs, headline accent words, key numerals, glow shadows (`0 0 40px rgba(247,197,72,0.35)`).

**Rules:** Dark theme only (no light mode in v1). Text contrast ≥ 4.5:1 for body. Never use pure `#fff` on pure `#000`.

### 2.2 Typography

| Role | Font | Notes |
|---|---|---|
| Display / headlines | **"Sora"** or **"Space Grotesk"** (Google Fonts) | 700–800 weight, `-0.02em` tracking, tight leading (`1.05`) |
| Body | **"Inter"** (Google Fonts) | 400/500, `1.6` line-height |
| Mono | **"JetBrains Mono"** (Google Fonts) | Terminal, code, stats, checksums |

Scale: hero `clamp(2.75rem, 7vw, 5.5rem)` → section titles `clamp(1.75rem, 4vw, 2.75rem)` → body `1.0625rem`.

### 2.3 Effects & motion

- **Gradient mesh hero** — 3–4 blurred radial blobs drifting on 24s CSS keyframe loops.
- **Particle canvas** — lightweight JS canvas (~80 particles, additive blending); paused offscreen; disabled if `prefers-reduced-motion`.
- **Glassmorphism** — `backdrop-filter: blur(16px)` cards on mesh backgrounds.
- **Glow** — sunrise `box-shadow` on primary CTAs; neon underlines on links.
- **3D tilt** — hero screenshot + feature cards, mouse-driven, max 4–8°, `perspective: 1200px`.
- **Scroll reveals** — IntersectionObserver, `translateY(24px)` + fade, 80ms stagger; once-only.
- **Typing animation** — hero prompt cycler + demo terminal; variable speed; respects reduced-motion (shows final text).
- **Count-up stats** — once on scroll into view.
- **Flowing connectors** — SVG dashed-line animation in How-it-works and Architecture.

**Motion budget:** all animations GPU-friendly (`transform`/`opacity` only). Total JS < 30KB gzipped (no framework needed if hand-rolled; see §3).

### 2.4 Responsive breakpoints

| Breakpoint | Layout |
|---|---|
| `< 640px` | Single column; hamburger nav; hero headline `2.75rem`; demo tabs scroll-x |
| `640–1024px` | 2-col feature grid; stacked how-it-works |
| `> 1024px` | Full 3-col grids; horizontal flows; max-width `1200px` container |

Mobile-first CSS. Touch: tilt effects disabled, tap targets ≥ 44px.

---

## 3. Tech Stack Recommendation

### Options considered

| Stack | Pros | Cons |
|---|---|---|
| **Astro** (static) | Zero-JS-by-default (perfect for content + islands of interactivity); Markdown-friendly; tiny output; great Lighthouse scores | Newer ecosystem; team must learn islands |
| **Next.js static export** | Familiar React; huge ecosystem | Heavier output for a mostly-static page; overkill |
| **Plain HTML/CSS/JS** | Zero build deps; smallest possible; full control | Manual upkeep; no components |

### Recommendation: **Astro**

**Why:** This page is 90% static content + 10% interactive islands (typing demo, tilt, counters, tabs). Astro ships zero JS by default and hydrates only the interactive bits — exactly matching the motion budget (<30KB JS). Markdown/MDX support makes future copy edits trivial. Output is plain static files → deployable anywhere.

**Runner-up:** plain HTML/CSS/JS — totally viable for v1 if the builder prefers zero toolchain; Astro is recommended for maintainability, not necessity.

### Hosting: **GitHub Pages** (primary) · Vercel (alternative)

**Recommendation: GitHub Pages**, served from the same `Vivek492005/Sunday` repo (e.g., `gh-pages` branch or `/landing` + Actions deploy):
- Free, zero new accounts, versioned with the code it markets.
- Custom domain supported (`sunday-ide.dev` or similar, optional).
- The repo already runs GitHub Actions — one more workflow is consistent.

**Alternative: Vercel/Cloudflare Pages** — better preview deployments per PR; worth it if the landing page gets frequent updates. Not needed for v1.

---

## 4. Deployment Plan

### 4.1 Repo layout

```
landing/                  # Astro project (or plain html/ for v1)
├── src/
│   ├── pages/index.astro # the page
│   ├── components/       # Nav, Hero, Features, Demo, ...
│   ├── styles/           # design tokens, base
│   └── assets/           # images, og-image
├── public/               # favicon, robots.txt
└── astro.config.mjs
```

> Keep the site **out of the release VSIX** — it's marketing, not product. Exclude via packaging config.

### 4.2 Build & deploy steps (GitHub Pages)

1. **Scaffold:** `npm create astro@latest landing -- --template minimal` (or copy the plain-HTML starter).
2. **Implement** sections per §1, tokens per §2.
3. **Add workflow** `.github/workflows/landing.yml`:
   ```yaml
   name: Deploy landing page
   on:
     push:
       branches: [main]
       paths: ['landing/**', '.github/workflows/landing.yml']
   permissions:
     contents: read
     pages: write
     id-token: write
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: withastro/action@v3        # or setup-node + npm run build
     deploy:
       needs: build
       runs-on: ubuntu-latest
       environment: { name: github-pages, url: ${{ steps.d.outputs.page_url }} }
       steps:
         - id: d
           uses: actions/deploy-pages@v4
   ```
4. **Repo settings** → Pages → Source: *GitHub Actions*.
5. **Verify:** `https://vivek492005.github.io/Sunday/` renders; Lighthouse ≥ 95 on performance/accessibility.
6. **(Optional) Custom domain:** add `landing/public/CNAME` with the domain; set DNS `CNAME` → `vivek492005.github.io`; enforce HTTPS.

### 4.3 Update triggers

- Re-deploy automatically on any `landing/**` push (workflow above).
- Download links + version badge read from a single `landing/src/data/release.json` (`{ "version": "0.1.0", "vsix_url": "…", "exe_url": "…" }`) so releases update the page in one edit.

---

## 5. Content Copy (final, not lorem ipsum)

### Nav
`Features · How it works · Docs · GitHub` — CTA: **Get Sunday**

### Hero
- **H1:** `Your editor, with an agent inside.`
- **Sub:** `Sunday is a VS Code-based IDE rebuilt around an autonomous coding agent. Describe the feature — it plans, codes, tests, and verifies. You review the diff.`
- **Primary CTA:** `Download for Windows`
- **Secondary CTA:** `See how it works`
- **Microcopy:** `v0.1.0 dev preview · Free & open source (Apache-2.0)`
- **Typing cycler prompts:**
  - `sunday chat "add JWT auth to the login route"`
  - `sunday chat "find the N+1 query and fix it"`
  - `sunday chat "write tests for the checkout flow"`

### Social proof
`Built on VS Code 1.140.0` · `~1,013 tests passing` · `16 packages` · `14-task eval benchmark` · `Apache-2.0`

### Features (headlines only; body in §1.4)
`Autonomous Agent` · `Editor Intelligence` · `Agent Browser` · `Parallel Agents` · `Fail-closed Security` · `Your Workflow, Your Way`

### How it works
`1. Describe` — `Type a task in chat, or speak it. @-mention the files that matter.`
`2. Agent works` — `It plans the change, reads code with semantic retrieval, edits with your approval, runs tests.`
`3. Review & merge` — `Inspect the diff, undo any hunk, accept. Background agents deliver as GitHub PRs.`

### Demo
Tab labels: `Terminal` · `Diff view` · `Chat UI`. Replay: `↻ Replay demo`.

### Architecture
Title: `Real engineering, not a wrapper.` Caption: `One daemon per OS user · Keys in env vars only · Fail-closed policy gate.` Link: `Read the architecture doc →`

### Code showcase
Title: `See what the agent produces.` Caption: `Output shape from the Sunday eval harness — 14 benchmark tasks, 100% tool-reliability target.`

### Use cases
`Solo developer` · `Team` · `Student / learner` (body in §1.9; honestly labeled personas, no fake quotes).

### Editions
**`Sunday — Free & Open Source`** · `$0` · `Apache-2.0. Every feature, every package. Bring your own API keys (OpenRouter and Groq both have free tiers).` CTA: `Download free →`

### Download
Title: `Get Sunday.` Version: `v0.1.0 dev preview`. Cards: `Windows installer` *(Recommended)* · `VSIX` · `CLI / source`. Setup steps: `1. Install` → `2. export OPENROUTER_API_KEY=…` → `3. Open the Sunday Chat view`. Link: `Full install guide →`

### Footer
`© 2026 Sunday · Apache-2.0` · `Built on VS Code 1.140.0 (MIT)` · `☀️ Build at the speed of thought.`

### Voice notes (for whoever writes more copy later)
Technical, confident, no hype. Say what it *does*, not what it *will revolutionize*. Never "10x". Never "game-changer". Numbers must be real (test counts from CI, version from release).

---

## 6. Asset List (to be created)

| # | Asset | Spec | Used in |
|---|---|---|---|
| 1 | **Hero screenshot** — Sunday IDE/chat UI in a real coding session | 1600×1000 PNG, dark editor, real code visible | Hero (§1.2) |
| 2 | **og-image** — social share card | 1200×630 PNG: logo + headline + gradient mesh bg | `<meta property="og:image">`, Twitter card |
| 3 | **Favicon set** — ☀️ mark | SVG + 32/180px PNG | `<head>` |
| 4 | **Demo GIF (fallback)** — 15s screen recording of the typed demo | 960px wide, < 3MB, for `prefers-reduced-motion` users and social | Demo section fallback |
| 5 | **Architecture diagram** — clean SVG version of the README diagram | SVG, brand colors, dark bg | Architecture (§1.7) |
| 6 | **Feature icons** — 6 minimal glyphs (agent, brain, globe, users, lock, terminal) | SVG set, 48px, stroke style, amber/cyan | Features grid |
| 7 | **Platform glyphs** — Windows logo, puzzle (VSIX), terminal | SVG, 32px | Download cards |
| 8 | **Logo lockup** — ☀️ + "Sunday" wordmark | SVG, horizontal + stacked | Nav, footer, og-image |

**How to produce:** screenshots from a real Sunday session (dogfood it); diagram via the README ASCII art → Figma/Excalidraw → SVG export; icons from Lucide/Phosphor (MIT/Apache-licensed) recolored to brand tokens. No AI-generated faces or fake testimonials — ever.

---

## 7. Open Questions (for the user, before build)

1. **Domain:** GitHub Pages default (`vivek492005.github.io/Sunday`) or custom domain now?
2. **Demo video:** scripted typing mock (recommended, ships fast) vs. real screen recording (needs a polished session)?
3. **Docs hosting:** keep docs on GitHub for v1, or also render them on the site later (Astro Starlight)?
4. **Analytics:** privacy-friendly (Plausible/Umami) or none for v1?

---

*Plan version: 2026-10-04. Next step after approval: scaffold `landing/` per §4 and implement sections in order §1.2 → §1.11 → rest.*
