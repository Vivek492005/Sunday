# Sunday Welcome — Design Doc (Phase 7)

**Status:** design only, not implemented
**Date:** 2026-10-13
**Trigger:** user: "this is VSCODE, i tell yu to create our own IDE"

---

## 1. Problem

The current welcome page is VS Code's information architecture with Sunday text
swapped in. From the user's screenshot:

- Header: "Sunday" + "Editing evolved" ← VS Code's tagline
- Left: Start (New File… / Open File… / Open Folder… / Clone Git Repository… /
  Connect to… / Generate New Workspace…) + Recent ← VS Code's exact list
- Right: Walkthroughs → "Learn the Fundamentals" ← VS Code's content
- Footer: agents banner (Copilot promo plumbing) + "Show welcome page on startup"

Nothing about this page says *Sunday* except the product name. A new user
cannot tell what Sunday adds over VS Code.

## 2. Welcome page audit (current)

Source: `vscode/src/vs/workbench/contrib/welcomeGettingStarted/`

| Piece | File | What it does | Why it looks like VS Code |
|---|---|---|---|
| Page shell / layout | `browser/gettingStarted.ts` (`GettingStartedPage`) | Renders header, two columns (Start+Recent \| Walkthroughs), footer | This 2-column IA **is** VS Code's welcome design |
| Header subtitle | `browser/gettingStarted.ts:930` | `localize('gettingStarted.editingEvolved', "Editing evolved")` | VS Code's tagline, verbatim |
| Start entries | `common/gettingStartedContent.ts` (`startEntries`) | New File / Open File / Open Folder / Clone / Connect to… / Generate Workspace | VS Code's standard set, no Sunday entries |
| Walkthroughs | `common/gettingStartedContent.ts` (builtin categories) | "Learn the Fundamentals" (Beginner), setup, notebooks | VS Code's onboarding content |
| Sunday walkthrough | `packages/ext-agent/package.json` → `contributes.walkthroughs` | "Get Started with Sunday" (5 steps, already exists) | Sits *alongside* VS Code's — doesn't replace |
| Agents banner | `browser/gettingStarted.ts` (`createAgentsBanner`) | Footer promo banner wired to Copilot chat setup | Copilot plumbing; should promote Sunday Agent |
| Startup logic | `browser/startupPage.ts` (`StartupPageRunnerContribution`) | Opens welcome per `workbench.startupEditor` | Fine as-is; no change needed |
| Styles | `browser/media/gettingStarted.css` | VS Code welcome visual language | Neutral enough, but tuned for VS Code IA |
| Media | `common/media/*.svg` | VS Code illustrations (settings, shortcuts, git…) | Generic; usable, but not Sunday |

### What is SAFE to change (display-only)

Per `docs/SAFE_CHANGE_GUIDELINES.md` and the Phase 5 audit: all of the above
are strings/layout/content. The DANGER is in service registration, which we do
**not** touch here — `gettingStarted.contribution.ts` registrations stay.

## 3. Sunday Home — what already exists

`packages/ext-agent/src/sundayHome.ts` — `SundayHomeProvider`
(`sunday.homeView`), a **sidebar** WebviewView behind the ☀️ activity-bar icon:

- Sign-in CTA card (Google/GitHub via Sunday gateway, free tier note)
- Streak card (🔥, tap to open streak view)
- 21 quick actions in 4 sections: **Agents** (Agent Chat, Agent Manager,
  Mission Control) · **Engagement** (Streaks, Usage, Scheduler) ·
  **Memory & Skills** (Memory, Skills, Artifacts) · **Power Tools**
  (Agent Modes, Design to Code, Best-of-N, Swarm, Cloud Tasks,
  Agent Browser, MCP Servers, Templates, Account)

### Should the welcome page BE the Sunday Home?

**No.** They are different surfaces with different jobs:

- **Sunday Home (sidebar):** persistent dashboard, always one click away.
  Keep it exactly where it is.
- **Welcome (editor):** first-run moment. This is the page a new user sees
  *before* they know the ☀️ icon exists.

**Best UX:** redesign the welcome *editor page* into a Sunday-first landing
that teaches the ☀️ Home, the agent, and sign-in — and deep-links into
Sunday Home features. The two surfaces reinforce each other instead of
competing.

## 4. Sunday welcome design

### 4.1 Principles

1. **Sunday first, editor second.** The first fold answers "what does Sunday
   give me that VS Code doesn't?" — agent, models, streaks, home.
2. **ADD > REMOVE.** Keep Recent (genuinely useful). Keep Start entries that
   are universal (New/Open). Reframe the rest around Sunday.
3. **No Copilot plumbing visible.** Agents banner promotes Sunday Agent.
4. **Every Sunday claim deep-links** to the real feature (chat, home, streak,
   guide) — no dead marketing.

### 4.2 Layout (replaces the 2-column VS Code IA)

```
┌─────────────────────────────────────────────────────────┐
│  ☀  Sunday                          [Sign in button]   │  ← hero bar
│  Your AI-native IDE. Code with your Sunday agent.       │  ← own tagline
│  [💬 Chat with Sunday] [☀ Open Sunday Home]             │
├─────────────────────────────────────────────────────────┤
│  MEET YOUR AGENT                                        │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                      │
│  │ Auto │ │Archit│ │Impl  │ │Review│  ← 4 modes          │
│  └──────┘ └──────┘ └──────┘ └──────┘                      │
│  4 models · @sunday in chat · session restore            │
├─────────────────────────────────────────────────────────┤
│  START                    │  SUNDAY TOURS               │
│  • New File…              │  • Get Started with Sunday  │ ← our walkthrough
│  • Open Folder…           │  • Meet the Agent (new)     │    (featured first)
│  • Clone Git Repository…  │  • Streaks & Usage (new)    │
│  ─────────                │                             │
│  RECENT                   │  (VS Code "Learn the        │
│  • …                      │   Fundamentals" demoted /   │
│                           │   hidden — see §4.4)         │
├─────────────────────────────────────────────────────────┤
│  [x] Show welcome page on startup                       │
└─────────────────────────────────────────────────────────┘
```

### 4.3 Content spec

**Hero (new).**
- Sunday sun mark + "Sunday" wordmark (use `branding/sunday-logo.jpg`
  asset; do not reuse VS Code's product icon slot styling).
- Tagline: **not** "Editing evolved". Proposed: "Your AI-native IDE."
  Sub: "Chat with your Sunday agent, keep your streak, ship faster."
  (Final wording: user's call — keep two options in the PR.)
- Primary CTAs: "💬 Chat with Sunday" (`sunday.chat.focus`) and
  "☀ Open Sunday Home" (reveal `sunday.homeView`).
- Sign-in state aware: signed out → "Sign in to Sunday" button
  (`sunday.account.showMenu`); signed in → show plan/tier chip.

**Meet your agent (new section).**
- 4 mode cards: Auto / Architect / Implementer / Reviewer — each card
  one line on what it does + click opens chat in that mode
  (`sunday.chat.focus` with mode arg; fall back to mode quickpick
  `sunday.mode.set` if deep-link args aren't supported).
- Footnote: "4 models via the Sunday gateway · `@sunday` anywhere ·
  sessions restore across restarts."

**Start (reframed `startEntries`).**
- Keep: New File…, Open File…, Open Folder…, Clone Git Repository…
- Add Sunday entries (same `startEntries` shape, new ids):
  - `sunday.welcome.chatWithAgent` — "Chat with Sunday Agent…" →
    `command:sunday.chat.focus`
  - `sunday.welcome.openHome` — "Open Sunday Home…" → reveal home view
  - `sunday.welcome.takeTour` — "Take the Sunday tour…" → opens our
    walkthrough (`sunday.getStarted`)
- Drop or demote: "Connect to…" (remote) stays but moves below Sunday
  entries; "Generate New Workspace…" stays.

**Sunday Tours (replaces Walkthroughs column).**
- Featured first: existing "Get Started with Sunday" walkthrough
  (`sunday.getStarted`, already contributed via extension point).
- New walkthroughs to author in `packages/ext-agent` (extension point,
  no workbench edits):
  1. `sunday.tour.agent` — "Meet the Agent": sign in → first chat →
     try a mode → `@sunday` mention.
  2. `sunday.tour.streaks` — "Streaks & Usage": open streaks → check
     usage → free-tier limits.
- VS Code's "Learn the Fundamentals": **demote** — keep available via
  "More…" but not in the featured column. (Hiding builtin walkthroughs
  entirely is a bigger change; demotion is the safe first step.)

**Recent:** keep as-is (limit 5), Sunday-neutral.

**Footer:** keep "Show welcome page on startup" checkbox; **replace**
`createAgentsBanner` (Copilot) with a Sunday Agent banner reusing the same
slot — same DOM position, Sunday copy + "Try it" → `sunday.chat.focus`.

### 4.4 What we deliberately do NOT do in this phase

- No change to `startupPage.ts` open logic or `workbench.startupEditor`.
- No removal of builtin walkthrough categories from the registry
  (demote in UI only).
- No new service registrations.
- Final tagline wording needs the user's pick (two options in PR).

## 5. Files to change

### Workbench (display-only edits — SAFE per audit)

| File | Change |
|---|---|
| `vscode/src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts` | `GettingStartedPage`: new hero section (branding, tagline, CTAs, sign-in state); new "Meet your agent" mode-cards section; right column retitled "Sunday Tours" with featured ordering; replace `createAgentsBanner` call with Sunday agent banner |
| `vscode/src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts` | `startEntries`: add 3 Sunday entries (chat, home, tour), reorder; keep the rest |
| `vscode/src/vs/workbench/contrib/welcomeGettingStarted/browser/media/gettingStarted.css` | Styles for hero, mode cards, tours column, Sunday banner |
| `vscode/src/vs/workbench/contrib/welcomeGettingStarted/common/media/` | New: `sunday-hero.svg` (sun mark), `sunday-agent.svg`; existing generic SVGs reused |

### Sunday extension (ADD via extension points — preferred)

| File | Change |
|---|---|
| `packages/ext-agent/package.json` | `contributes.walkthroughs`: add `sunday.tour.agent` and `sunday.tour.streaks` (steps reference existing `sunday.*` commands) |
| `packages/ext-agent/` (new, e.g. `walkthroughs/`) | Markdown/JSON content for the two new tours (media via `markdown` type or new SVGs) |

### Not touched

- `browser/startupPage.ts` — open logic unchanged
- `browser/gettingStarted.contribution.ts` — registrations unchanged
- `browser/gettingStartedService.ts` — walkthrough plumbing unchanged
- `browser/gettingStartedInput.ts`, `gettingStartedList.ts`,
  `gettingStartedDetailsRenderer.ts` — unchanged

## 6. Verification plan (for implementation PR)

1. `node scripts/verify-product-json.mjs` — unchanged, still green.
2. Typecheck the workbench (`npm run gulp core-ci` equivalent in CI).
3. Installed-build check (Windows): fresh profile → welcome shows Sunday
   hero, 4 mode cards, Sunday Tours with our walkthrough featured,
   no "Editing evolved", no Copilot banner, no "Learn the Fundamentals"
   in the featured column.
4. Click-through: every CTA on the page fires its command (chat, home,
   sign-in, tour steps).
5. `workbench.startupEditor: none` → welcome does not open (no regression).

## 7. Open questions for the user

1. Tagline: "Your AI-native IDE." vs "Code with your AI crew." (pick one)
2. Keep VS Code's "Learn the Fundamentals" reachable under "More…", or
   hide it from the welcome page entirely?
3. Should the hero show the official `branding/sunday-logo.jpg`, or the
   generated sun mark from the LinkedIn banner?
