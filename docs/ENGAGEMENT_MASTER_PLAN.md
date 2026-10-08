# 🎮 Sunday Engagement Master Plan

**Version:** 3.0 | **Date:** 2026-10-08 | **Status:** Streaks implementing
**Research:** Duolingo, LeetCode, GitHub, Codewars, Habitica

---

## Golden Rule

> **Reward shipped work, not app opens.**
> Commit, tests, PRs, AI tasks — yehi count hoga. Sirf IDE kholna count nahi hoga.
> *(GitHub ne 2016 me streak counter hataya tha kyunki log fake presence dikhane lage the — ye galti nahi dohraenge.)*

---

## 🔇 Two-Mode Design (founder requirement — sabse important!)

Engagement **kabhi** normal VS Code workflow me interfere nahi karega.

### Passive Mode (sirf file read/write/edit, AI agents nahi use kar raha)
- Sirf streak day **silently** track hogi (background me, pata bhi nahi chalega)
- Status bar me bas `🔥 12` — ek chhota number, koi disturbance nahi
- ❌ Koi quest prompt nahi
- ❌ Koi XP popup nahi
- ❌ Koi achievement toast nahi
- ✅ Sirf ye 2 notifications (max 1/day):
  - Streak milestone: "🎉 7-day streak! +100 bonus/day unlocked!"
  - 8 PM at-risk: "🔥 Streak khatre me hai, thoda code kar lo"

### Active Mode (AI agents use kar raha hai)
- 🎉 Full engagement: quests, achievements, XP, celebrations
- 🎁 Bonus rate limit unlock notifications
- Quest progress updates, achievement toasts

### Auto-Detect kaise?
- Setting: `sunday.engagement.quietMode` (default: auto)
- Session me **pehli AI agent use** pe active mode on ho jayega
- Usse pehle bilkul shaant — jaise engagement system hai hi nahi
- Streak tracking **dono modes** me chalti hai (foundation hai)

> **Principle:** *Jo user sirf code edit kar raha hai, use kabhi tang mat karo. Engagement uske kaam ke aas-paas ho, uske kaam ke beech me nahi.*

---

## Mechanic 1: 🔥 Coding Streaks [+ Bonus Rate Limits]

**Status:** 🟡 Implementing (worker active)

### Streak Day kaise milega?
| Action | Minimum |
|---|---|
| Git commit | 1 commit |
| Active editing | 30+ min coding |
| PR merge | 1 PR |
| AI task complete | 1 successful task |

### Safety Nets
- 🛡️ **Streak Freeze:** Har 7-day streak pe 1 freeze (max 3). Miss → auto-use, streak bachi.
- 🏖️ **Vacation Mode:** 14 din/saal pause. Streak na badhegi, na tootegi.

### 🎁 Bonus Rate Limits (founder ka idea!)

| Streak | Bonus/day | Free tier total |
|---|---|---|
| 0-6 din | +0 | 200 |
| **7 din** | **+100** | **300** 🎉 |
| **14 din** | **+200** | **400** 🎉🎉 |
| **30 din** | **+500** | **700** 🎉🎉🎉 |

- Bonus sirf active streak pe. Tooti → wapas base.
- Paid plans pe stack: Pro (3000) + 30-day (500) = **3500/day**
- Dashboard me alag dikhega: `Base: 200 + Streak: 100 = 300`

### UI
- Status bar: `🔥 12` → click = streak panel
- Panel: current/longest streak, freezes, next milestone progress bar
- Notifications: milestone hit, freeze earned/used, 8 PM at-risk nudge (streak ≥ 3)
- Settings: on/off, notifications on/off

### Privacy
- Sab local (`~/.sunday/engagement/`). Server ko sirf number jata hai.
- Ek setting se full opt-out.

**Detail doc:** `docs/STREAK_PLAN.md`

---

## Mechanic 2: 📊 Activity Heatmap

**Status:** ⬜ Planned (streaks ke baad)

GitHub ke green squares jaisa, IDE ke andar:
- Daily intensity: commits (3x) + lines changed (1x) + tests (2x) + AI tasks (2x)
- Click day → drill down: kya kaam kiya, kaunse repos
- Weekly summary: "12 commits, 3 repos this week"
- Streak engine ka activity data reuse karega (dobara tracking nahi)
- Local by default, opt-in sync for teams

---

## Mechanic 3: 🏅 Proficiency Ranks

**Status:** ⬜ Planned

Codewars style (8 kyu → 8 dan), hamare ranks:
```
Novice → Apprentice → Coder → Developer → Craftsman → Expert → Master
```
- Rank **sirf quality signals** se badhega:
  - Tests first-try pass
  - PR merged bina rework
  - AI suggestion accept + kept (1 hr me revert nahi)
  - Code review approvals
- **Anti-farming:** Har rank ke liye ~3x points (grinding easy tasks = diminishing returns)
- Rank = credible signal, XP jaisa farm nahi ho sakta

---

## Mechanic 4: ⚔️ Daily Quests

**Status:** ⬜ Planned

LeetCode daily challenge jaisa — roz 3 naye quests:
- Easy: "5 AI suggestions accept karo" (20 XP)
- Medium: "Saare lint errors clear karo" (30 XP)
- Hard: "Bina test wale function ke tests likho" (50 XP)
- Quests codebase se adapt hongi ("3 files me TODO comments hain")
- **Personal daily goal** bhi set kar sakte ho (Duolingo style)
- Teenon complete = bonus XP + streak day credit

---

## Mechanic 5: 👥 Squad Goals (celebration-only)

**Status:** ⬜ Planned (social phase)

- 10 logon tak ki squad, invite link se join
- Shared weekly goal: "Team se 50 commits"
- **Sirf celebration, koi guilt nahi:**
  - ✅ "Rahul ne 30-day streak hit kiya! 🎉" — sabko notify
  - ❌ "Tumhare teammate ne miss kiya" — kabhi nahi
- Squad heatmap: combined activity view
- Git-synced data, no accounts needed for basic squads
- *(Habitica ki guilt mechanics ne friendships damage kiye — hum nahi dohraenge)*

---

## Mechanic 6: 🏆 Tiered Achievements

**Status:** ⬜ Planned

### Tier A — Day-1 Wins (turant dopamine!)
- "First Commit" — Sunday se pehla commit
- "Hello AI" — pehli AI suggestion accept
- "Test Pilot" — pehla test run
- *(Duolingo: 43% unlocks day one pe hote hain)*

### Tier B — Rare Badges (functional unlocks!)
- "Bug Slayer" (100 bugs fix) → advanced debugging lens unlock
- "Speed Demon" (50 AI tasks) → batch AI operations unlock
- "Marathoner" (30-day streak) → custom themes unlock
- *(Sirf image nahi — real features! Codewars model)*
- Retention difficulty ke saath badhta hai: 32% → 74%

---

## Mechanic 7: 🏁 Weekly Leagues

**Status:** ⬜ Planned (backend chahiye)

Duolingo ka sabse powerful feature:
- Har Monday, ~30 users ki league (similar activity level)
- Ranking **shipped work** pe, raw XP pe nahi
- Top 3 promote, bottom 3 demote
- Leagues: Bronze → Silver → Gold → Diamond → Legendary
- Opt-in, anonymous username allowed, kabhi bhi leave
- *(Duolingo results: +1/+2/+3% D1/D7/D14 retention, +17% time)*

---

## Cross-Cutting: XP Currency

Sab systems ko jodne wali ek currency:

| Action | XP |
|---|---|
| Commit pushed | 10 |
| PR merged | 50 |
| AI suggestion accepted & kept | 5 |
| Test written & passing | 15 |
| Daily quest (easy/med/hard) | 20/30/50 |
| Streak day bonus | 25 |

XP → streak display, league ranking, achievement progress, rank advancement.

---

## Implementation Order

| Phase | Mechanics | Status |
|---|---|---|
| **E.1** | 🔥 Streaks + Bonus Limits | 🟡 Implementing |
| **E.2** | 📊 Heatmap + ⚔️ Quests + 🏆 Day-1 Achievements | ⬜ Next |
| **E.3** | 🏅 Ranks + 🏆 Rare Badges | ⬜ Planned |
| **E.4** | 👥 Squads + 🏁 Leagues (backend) | ⬜ Planned |

**Har phase:** implement → test → commit → push → CI green → next phase.

---

## Kya NAHI karenge

| ❌ Don't | Kyun |
|---|---|
| App opens pe reward | GitHub ne prove kiya — fake engagement |
| Guilt mechanics | Habitica ne friendships damage kiye |
| Bina protection ke streaks | 1 miss = permanent churn |
| Global leaderboard | #50,000 rank dekh ke naye users quit |
| Pay-to-win XP | Rank ki credibility khatm |

---

## Success Metrics

- **D1/D7/D30 retention** (primary metric)
- Streak adoption (% users with streak ≥ 7)
- Quest completion rate
- League opt-in rate
- **Streak length vs paid conversion** correlation

---

## Docs Index

- `docs/ENGAGEMENT_PLAN.md` — original 7-mechanic research plan
- `docs/STREAK_PLAN.md` — streak system detailed working
- `docs/ENGAGEMENT_MASTER_PLAN.md` — ye file (master overview)
