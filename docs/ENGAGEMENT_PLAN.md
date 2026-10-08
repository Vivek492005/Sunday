# Sunday Engagement Plan — Gamification & Daily Active Usage

**Version:** 1.0 | **Date:** 2026-10-08 | **Status:** Design (not implemented)
**Research basis:** Duolingo, LeetCode, GitHub, Codewars, Habitica mechanics analysis

---

## Core Principle

> **Reward shipped work, not app opens.** Every mechanic below is gated on productive output — commits pushed, tests passing, AI suggestions accepted-and-kept, lint errors cleared. Never reward just opening the IDE.
>
> *Why:* GitHub removed its streak counter in 2016 after research showed long-streak users made minimum-effort "presence" contributions on 36%+ of streak days. Streak pressure without quality gates produces presence, not productivity.

---

## The 7 Engagement Mechanics

### 1. 🔥 Coding Streaks (with safety nets)

**Inspired by:** Duolingo (loss-aversion backbone), Habitica (vacation mode)

**How it works:**
- A "streak day" = at least one meaningful coding action (commit, 30+ min active editing, PR merged, or AI task completed)
- Streak counter in status bar: `🔥 12`
- **Streak Freeze:** Earn 1 freeze per 7-day streak (max 3 stored). Miss a day → freeze auto-consumed, streak survives
- **Vacation Mode:** Pause streak up to 14 days/year, no questions asked
- **Streak-at-risk notification:** Gentle nudge at 8 PM if no coding activity today (only when streak ≥ 3, max 1/day)

**Why it works:** Loss aversion is the strongest retention driver. But without freezes, one missed day kills motivation permanently. Duolingo data: users with streak protection keep streaks ~4.5x longer.

### 🎁 Streak Rewards: Free Rate Limits

Streaks earn **bonus AI requests** on top of the daily free tier:

| Streak Milestone | Bonus | Total Daily (Free tier) |
|---|---|---|
| 7 days (1 week) | **+100 req/day** | 300/day |
| 14 days (2 weeks) | **+200 req/day** | 400/day |
| 30 days (1 month) | **+500 req/day** | 700/day |

**Rules:**
- Bonus applies to the **current day only** while streak is active (not retroactive)
- If streak breaks, bonus resets to base (200/day)
- Streak Freeze used → streak survives → bonus continues
- Paid plans: streak bonus stacks on top of plan limits (reward loyalty at every tier)
- Bonus requests are labeled `streak_bonus` in usage metering (separate from base quota)

**Why this is powerful:** It creates a self-reinforcing loop — code daily → earn more AI requests → build more → code daily. The reward is the product itself, not a cosmetic badge.

**Anti-gaming:** Same as streaks — bonus requires a *meaningful* streak day (commit, 30+ min editing, PR, or AI task). Opening the app doesn't count.

**Anti-gaming:** Minimum bar for a streak day (not just opening the app). See Core Principle.

---

### 2. 📊 Activity Heatmap

**Inspired by:** GitHub contribution graph, Codewars activity

**How it works:**
- In-editor heatmap (sidebar panel or dashboard) showing daily coding intensity
- Intensity = weighted score: commits (3x), lines changed (1x), tests run (2x), AI tasks completed (2x)
- Click a day → drill down: what you worked on, repos touched, AI usage
- Weekly/monthly summaries: "You shipped 12 commits across 3 repos this week"

**Privacy:** All data stays local by default. Opt-in to sync for team features.

**Why it works:** The GitHub green-squares graph is the most imitated engagement mechanic in developer tools. It turns consistency into identity — "I'm someone who codes every day."

---

### 3. 🏅 Proficiency Ranks (anti-farming curve)

**Inspired by:** Codewars (8 kyu → 8 dan)

**How it works:**
- Ranks: `Novice → Apprentice → Coder → Developer → Craftsman → Expert → Master`
- Rank increases ONLY from shipped work quality signals:
  - Tests passing on first run
  - PRs merged without rework
  - AI suggestions accepted and kept (not reverted within 1 hour)
  - Code review approvals received
- **Anti-farming:** Each rank requires ~3x the points of the previous (Codewars model). Grinding easy tasks yields diminishing returns.
- Rank shown on profile, optionally on leaderboards

**Why it works:** Codewars proves developers value skill-gated progression. Ranks become credible signals — unlike XP which can be farmed, rank requires real output.

---

### 4. ⚔️ Daily Coding Quests

**Inspired by:** Duolingo daily quests, LeetCode daily challenge

**How it works:**
- Every day, 3 rotating quests appear:
  - Easy: "Accept 5 AI suggestions" 
  - Medium: "Clear all lint errors in current file"
  - Hard: "Write tests for an untested function" / "Refactor a function over 50 lines"
- User can also set a **personal daily goal** (Duolingo-style): "I want to ship 1 commit today"
- Completing all 3 = bonus XP + streak day credited
- Quests adapt to the user's codebase (e.g., "you have 3 files with TODO comments")

**Why it works:** Gives users a reason to open the IDE with purpose. LeetCode's daily challenge is their #1 retention mechanic. Personal goals create commitment.

---

### 5. 👥 Opt-In Team Accountability (celebration-only)

**Inspired by:** Habitica parties (minus guilt), Duolingo friend streaks

**How it works:**
- Create or join a "squad" (up to 10 people) via invite link
- Shared weekly goal: "Ship 50 commits as a team"
- **Celebration-only:** When someone hits a milestone, everyone gets notified to celebrate. NO penalties, NO "your teammate missed a day" guilt.
- Squad heatmap: combined activity view
- Works via git-synced data (no accounts needed for basic squads)

**Why it works:** Duolingo found ~1/3 of DAUs use friend features, and social obligation outlasts anonymous competition. But Habitica's guilt mechanics damage friendships — so we do celebration-only.

---

### 6. 🏆 Tiered Achievements (day-1 wins + rare badges)

**Inspired by:** Duolingo achievements, GitHub badges, Codewars privileges

**Two tiers:**

**Tier A — Day-1 Wins** (43% of Duolingo unlocks happen on day one):
- "First Commit" — push your first commit from Sunday
- "Hello AI" — accept your first AI suggestion
- "Test Pilot" — run your first test
- Purpose: immediate dopamine, teach features through play

**Tier B — Rare Badges** (with FUNCTIONAL unlocks, not just cosmetics):
- "Bug Slayer" (fix 100 bugs) → unlocks advanced debugging lens
- "Speed Demon" (50 AI tasks completed) → unlocks batch AI operations
- "Marathoner" (30-day streak) → unlocks custom themes
- Purpose: long-term goals, retention scales with difficulty (32% → 74%)

**Key insight:** Codewars gates functional privileges behind Honor, not cosmetics. Unlocking real features is more motivating than a badge image.

---

### 7. 🏁 Weekly Leagues (segmented, ~30 users)

**Inspired by:** Duolingo leagues (their biggest single retention feature)

**How it works:**
- Every Monday, users placed in leagues of ~30 with similar activity levels
- Ranked on **shipped work** (commits, PRs merged, tests passing) — NOT raw XP
- Top 3 promoted to higher league, bottom 3 demoted
- League names: Bronze → Silver → Gold → Diamond → Legendary
- Opt-in only, anonymous usernames allowed

**Why it works:** Duolingo's biggest retention win: +1/+2/+3% on D1/D7/D14 retention, +17% learning time. Segmented leagues mean you're always competing with peers, not whales.

**Privacy:** Opt-in. No real names required. Can leave anytime.

---

## Cross-Cutting: XP Currency

One common XP currency ties all systems together:
- Commit pushed: 10 XP
- PR merged: 50 XP
- AI suggestion accepted-and-kept: 5 XP
- Test written and passing: 15 XP
- Daily quests: 20/30/50 XP
- Streak day: 25 XP bonus

XP feeds: streak display, league ranking, achievement progress, rank advancement.

---

## Implementation Phases

### Phase E.1 — Foundation (local-first, no backend)
- [ ] Activity tracking engine (editor telemetry → local SQLite)
- [ ] Streak counter + freeze + vacation mode
- [ ] Heatmap panel
- [ ] Day-1 achievements
- [ ] Daily quests (local generation)

### Phase E.2 — Progression
- [ ] XP system + proficiency ranks
- [ ] Tiered achievements with functional unlocks
- [ ] Personal daily goals

### Phase E.3 — Social (opt-in)
- [ ] Squad creation + shared goals (git-synced)
- [ ] Weekly leagues (requires backend leaderboard)
- [ ] Celebration notifications

### Phase E.4 — Polish
- [ ] Streak-at-risk smart notifications
- [ ] Weekly summary emails/reports
- [ ] Achievement showcase page

---

## What NOT to Do (learned from research)

| Don't | Why |
|---|---|
| Reward app opens | GitHub proved this creates fake engagement |
| Guilt mechanics ("your team is disappointed") | Habitica data shows friendship damage |
| Unprotected streaks | One missed day = permanent churn |
| Global leaderboards | New users see rank #50,000 and quit |
| Pay-to-win XP boosts | Destroys rank credibility |

---

## Success Metrics

- **D1/D7/D30 retention** (primary)
- **Streak adoption rate** (% of users with streak ≥ 7)
- **Quest completion rate**
- **League opt-in rate**
- **Correlation:** Does streak length predict paid conversion?

---

*Research sources: Duolingo gamification case study (trophy.so), LeetCode community docs, GitHub streak removal study (arxiv 2006.02371), Codewars official docs, Habitica wiki, DevGotchi VS Code extension.*
