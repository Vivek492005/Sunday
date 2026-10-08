# 🎮 Sunday Engagement — Detailed Plan (Mechanics 3-7)

**Version:** 1.0 | **Date:** 2026-10-08
**Companion to:** `ENGAGEMENT_MASTER_PLAN.md` (v3.0), `STREAK_PLAN.md`

> **Two-mode rule applies to ALL mechanics below:** Passive mode (normal editing) me koi popup/prompt nahi. Full engagement sirf Active mode (AI agents use) me.

---

## ⚔️ DAILY QUESTS — Full Design

### Structure
- **Roz 3 quests:** 1 Easy + 1 Medium + 1 Hard
- **1 Weekly quest:** Bada challenge, poore hafte ka time
- Reset: roz raat 12 baje (local timezone)
- Teenon complete = **Quest Bonus:** +50 XP + streak day auto-credit

### Quest Pool (rotation se aayenge)

#### 🟢 EASY (20 XP each — roz 1)
| Quest | Kaise complete |
|---|---|
| First Suggestion | 1 AI suggestion accept karo |
| Quick Commit | 1 commit push karo |
| Test Runner | 1 baar tests chalao |
| File Explorer | 5 alag files me edit karo |
| Shortcut Learner | 1 keyboard shortcut use karo (Ctrl+P, Ctrl+Shift+F, etc.) |

#### 🟡 MEDIUM (35 XP each — roz 1)
| Quest | Kaise complete |
|---|---|
| AI Collaborator | 5 AI suggestions accept karo |
| Lint Cleaner | Saare lint errors clear karo (current file) |
| TODO Hunter | 3 TODO comments resolve karo |
| Test Writer | 1 naye function ke liye test likho |
| Refactorer | 1 function ko chhota/saaf karo |

#### 🔴 HARD (50 XP each — roz 1)
| Quest | Kaise complete |
|---|---|
| Agent Commander | 3 AI agent tasks successfully complete karo |
| Bug Slayer | 1 failing test ko pass karwao |
| Coverage Booster | Kisi file ki test coverage 10% badhao |
| PR Shipper | 1 PR create karo ya merge karo |
| Deep Refactor | 50+ line wale function ko refactor karo |

#### 🟣 WEEKLY QUEST (150 XP — hafte me 1)
| Quest | Kaise complete |
|---|---|
| Shipped It | 5 commits + 1 PR merge ek hafte me |
| Quality Week | 0 lint errors + saare tests green (3 din lagatar) |
| AI Power User | 20 AI agent tasks ek hafte me |
| Test Guardian | 10 naye tests likho ek hafte me |

### Smart Quest Selection (adaptive)
- Quests user ke codebase se adapt hongi:
  - Agar 5 TODO comments hain → "TODO Hunter" aayega
  - Agar lint errors hain → "Lint Cleaner" aayega
  - Agar tests nahi hain → "Test Writer" aayega
- Pehle kabhi complete na kiya quest → priority milegi (variety)
- Bahut aasaan lagne lage to difficulty auto-badhegi

### UI
- Sidebar me "Today's Quests" panel (sirf Active mode me visible)
- Progress bar har quest pe: `AI Collaborator ████████░░ 3/5`
- Complete pe: subtle checkmark animation (koi bada popup nahi)
- Teenon done: "🎉 All quests complete! +50 XP bonus"

---

## 🏆 ACHIEVEMENTS — Full List

### Design Principles
- **Tier A (Day-1):** Turant dopamine — pehle din 3-4 unlock hone chahiye
- **Tier B (Rare):** Lambi mehnat — functional unlocks ke saath
- Har achievement: Name + Icon + Requirement + Reward

---

### 🟢 TIER A: Getting Started (Day-1 Wins)

| # | Achievement | Requirement | Reward |
|---|---|---|---|
| 1 | 👋 Hello Sunday | Pehli baar Sunday kholo | — (welcome!) |
| 2 | 🤖 Hello AI | Pehli AI suggestion accept karo | — |
| 3 | 📝 First Commit | Sunday se pehla commit push karo | — |
| 4 | 🧪 Test Pilot | Pehli baar tests chalao | — |
| 5 | ⌨️ Shortcut Pro | 5 alag keyboard shortcuts use karo | Command palette tips unlock |

**Target:** Naya user pehle din 3-4 achievements unlock kare → turant "ye IDE samajhta hai mujhe" feeling.

---

### 🟡 TIER B: Streak & Consistency

| # | Achievement | Requirement | Reward |
|---|---|---|---|
| 6 | 🔥 Week Warrior | 7-day streak | +100 bonus req/day (auto) |
| 7 | 🔥🔥 Fortnight Fighter | 14-day streak | +200 bonus req/day (auto) |
| 8 | 🔥🔥🔥 Month Master | 30-day streak | +500 bonus req/day + exclusive theme |
| 9 | 🛡️ Guardian | Pehli baar Streak Freeze use karo | +1 bonus freeze |
| 10 | 🏖️ Smart Breaker | Vacation mode use karke streak bachao | — |

---

### 🟠 TIER C: AI Mastery

| # | Achievement | Requirement | Reward |
|---|---|---|---|
| 11 | 🤖 AI Apprentice | 10 AI suggestions accept karo | — |
| 12 | 🤖 AI Partner | 100 AI suggestions accept karo | Batch accept feature unlock |
| 13 | 🤖 AI Master | 500 AI suggestions accept karo | Custom AI instruction profiles |
| 14 | 🎯 Task Runner | 10 AI agent tasks complete karo | — |
| 15 | 🎯 Task Commander | 50 AI agent tasks complete karo | Parallel agent tasks unlock |
| 16 | 🎯 Task Legend | 200 AI agent tasks complete karo | Priority agent queue |
| 17 | 🧠 Prompt Crafter | 1 custom agent mode banao | Share mode with community |

---

### 🔵 TIER D: Code Quality

| # | Achievement | Requirement | Reward |
|---|---|---|---|
| 18 | 🧹 Clean Coder | 100 lint errors fix karo | Advanced lint rules unlock |
| 19 | 🐛 Bug Hunter | 10 bugs fix karo (failing test → pass) | — |
| 20 | 🐛🐛 Bug Slayer | 100 bugs fix karo | Advanced debugging lens unlock |
| 21 | ♻️ Refactor Pro | 10 functions refactor karo | Code complexity analyzer |
| 22 | 📝 Doc Writer | 20 functions me JSDoc/comments add karo | Auto-doc generator |

---

### 🟣 TIER E: Testing

| # | Achievement | Requirement | Reward |
|---|---|---|---|
| 23 | 🧪 Test Starter | 10 tests likho | — |
| 24 | 🧪 Test Guardian | 100 tests likho | Coverage heatmap unlock |
| 25 | 🧪 Test Centurion | 500 tests likho | Mutation testing tools |
| 26 | 💯 Perfect Run | Saare tests pass, 0 fail (10 baar) | — |
| 27 | 🛡️ Coverage King | Kisi project me 80%+ coverage lao | Coverage trend dashboard |

---

### 🟤 TIER F: Collaboration & Shipping

| # | Achievement | Requirement | Reward |
|---|---|---|---|
| 28 | 🚀 First Ship | Pehla PR merge karo | — |
| 29 | 🚀 Shipper | 10 PRs merge karo | PR template generator |
| 30 | 🚀 Release Captain | 50 PRs merge karo | Auto-changelog generator |
| 31 | 👀 Reviewer | 10 PRs review karo | Review checklist templates |
| 32 | 🌟 Open Source Hero | Public repo me contribute karo | Profile badge |

---

### ⚫ TIER G: Exploration (hidden achievements!)

| # | Achievement | Requirement | Reward |
|---|---|---|---|
| 33 | 🌙 Night Owl | Raat 12-4 baje coding karo | Dark theme pack |
| 34 | 🌅 Early Bird | Subah 5-7 baje coding karo | Light theme pack |
| 35 | 🗺️ Explorer | 10 alag Sunday features try karo | — |
| 36 | 🔧 Tinkerer | 5 settings customize karo | — |
| 37 | ⌨️ Keyboard Ninja | Bina mouse ke 1 ghanta coding karo | Vim keybinding pack |

**Hidden = aur maza!** User ko nahi pata kab unlock hoga → delightful surprise.

---

### Achievement UI
- Toast notification (sirf Active mode): "🏆 Achievement Unlocked: Bug Slayer!"
- Achievement gallery: Profile me saare badges, locked/unlocked
- Progress: "Bug Slayer ████████░░ 73/100"
- Rare achievements pe thoda bada celebration (confetti animation 🎊)

**Total: 37 achievements** (5 + 5 + 7 + 5 + 5 + 5 + 5)

---

## 🏅 RANKS — Full Design

### Rank Ladder (7 ranks)

```
🌱 Novice → 🌿 Apprentice → 💻 Coder → 🛠️ Developer → 🎨 Craftsman → ⭐ Expert → 👑 Master
```

### Rank kaise decide hogi? (Points System)

**Rank Points** alag hain XP se. XP har action pe milta hai, Rank Points sirf **quality signals** pe:

| Quality Signal | Rank Points |
|---|---|
| Test first-try pass | +10 |
| PR merged bina rework ke | +25 |
| AI suggestion accept + 1 hr tak kept (revert nahi) | +5 |
| Code review approval mila | +15 |
| Bug fix (failing → passing test) | +20 |
| Lint errors zero (poore din) | +10 |

| Negative Signal | Rank Points |
|---|---|
| AI suggestion accept karke 1 hr me revert | -3 |
| PR me requested changes aaye | -5 |
| Test fail hua jo tumne likha tha | -2 |

### Anti-Farming Curve (Codewars model)

Har rank ke liye ~3x points chahiye:

| Rank | Points Required | Matlab |
|---|---|---|
| 🌱 Novice | 0 (starting) | Sab yahan se shuru |
| 🌿 Apprentice | 100 | ~2 hafte regular coding |
| 💻 Coder | 300 | ~1.5 mahine |
| 🛠️ Developer | 900 | ~4 mahine |
| 🎨 Craftsman | 2,700 | ~1 saal |
| ⭐ Expert | 8,100 | ~2-3 saal |
| 👑 Master | 24,300 | Top 1% developers |

**Kyun 3x?** Aasaan tasks grind karke rank nahi badha sakte. Har rank genuinely zyada skill maangta hai. Codewars ne ye prove kiya hai.

### Rank Decay (inactive users ke liye)
- 30 din koi activity nahi → rank points 10% kam
- 90 din nahi → ek rank neeche (Master → Expert)
- Wapas aane pe jaldi recover (2x points 7 din tak — "comeback bonus")

### Rank UI
- Profile pe badge: `⭐ Expert (3,247 pts)`
- Status bar me chhota icon (optional, setting se on/off)
- Rank-up pe celebration: "🎉 Rank Up! You are now a Developer!"
- Leaderboard pe rank-wise filter

### Rank vs XP — farak kya hai?

| | XP | Rank Points |
|---|---|---|
| Milta hai | Har action pe | Sirf quality pe |
| Kam hota hai | Kabhi nahi | Inactivity pe decay |
| Farm ho sakta | Haan (grind) | Mushkil (3x curve) |
| Matlab | "Kitna active hai" | "Kitna skilled hai" |

---

## 👥 SQUADS — Full Design

### Kya hai Squad?
10 logon tak ki team. Dost, colleagues, ya coding bootcamp batch. Shared goals, shared celebrations.

### Squad kaise banegi?
1. `Sunday: Create Squad` → naam do ("Code Warriors")
2. Invite link generate: `sunday.gg/squad/abc123`
3. Dost link pe click → join (Sunday account chahiye)
4. Max 10 members

### Squad Goals (weekly, auto-rotate)

| Week | Team Goal | Reward (sabko) |
|---|---|---|
| 1 | 50 commits as a team | +25 XP each |
| 2 | 10 PRs merged as a team | +50 XP each |
| 3 | 0 lint errors (sabke projects) | +50 XP each |
| 4 | 100 tests written as a team | +75 XP each |

- Goal complete = **sabko** reward (team effort!)
- Ek banda zyada kare to bhi sabko milega (collaboration > competition)

### Celebration-Only (NO guilt!)

✅ **Hoga:**
- "🎉 Rahul ne 30-day streak hit kiya!" → squad me notify
- "🎉 Squad goal complete! 52/50 commits!" → sabko XP
- Weekly squad summary: "Is hafte: 47 commits, 8 PRs, 156 tests"

❌ **Kabhi nahi hoga:**
- "Tumhare teammate ne aaj code nahi kiya" 
- "Squad goal fail — Priya ne contribute nahi kiya"
- Kisi ka naam leke blame

### Squad Heatmap
- Combined team activity view
- Har member ka anonymous contribution (opt-in pe naam)
- "Squad streak": kitne din lagatar kisi na kisi ne code kiya

### Squad Leaderboard (opt-in)
- Squad ke andar friendly ranking (shipped work pe)
- Sirf squad members dekh sakte hain
- Bahar ki duniya ko nahi dikhega

### Privacy
- Join/leave kabhi bhi, koi penalty nahi
- Anonymous mode: "Member #3" banke participate karo
- Squad data sirf members dekh sakte hain

### Interaction kaise enhance karega?
1. **Accountability:** "Meri squad dekh rahi hai" → roz kholne ka reason
2. **Celebration:** Dost ki jeet pe khushi → positive loop
3. **Friendly competition:** Squad leaderboard → "main #2 se #1 banna hai"
4. **Belonging:** "Main Code Warriors ka hun" → identity

---

## 🏁 LEAGUES — Full Design

### Kya hai League?
Duolingo ka sabse powerful feature. Weekly competition, ~30 similar-level users.

### Structure

```
🥉 Bronze → 🥈 Silver → 🥇 Gold → 💎 Diamond → 🏆 Legendary
```

### Placement (pehli baar)
- Naya user: activity level dekh ke Bronze/Silver me place
- Pehle hafte ka performance → sahi league me adjust

### Weekly Cycle
- **Monday 00:00:** Nayi league shuru, sab zero se
- **Sunday 23:59:** League khatm, results
- **Scoring:** Sirf shipped work (XP nahi!)

| Action | League Points |
|---|---|
| Commit pushed | 10 |
| PR merged | 50 |
| Test written & passing | 15 |
| AI task completed | 10 |
| Daily quests complete (3/3) | 30 bonus |

### Promotion/Demotion (har Sunday raat)

| Position (30 me se) | Result |
|---|---|
| Top 3 🥇🥈🥉 | ⬆️ Promote (next league up) |
| 4-24 | ➡️ Stay (same league) |
| Bottom 3 | ⬇️ Demote (next league down) |
| Legendary top 3 | 🏆 Champion badge (stay Legendary) |

### Anti-Toxicity
- **Segmented:** Hamesha similar level ke 30 log (naye user ko pros se nahi ladayenge)
- **Anonymous option:** Username chhupao, "Coder #12" banke khelo
- **Opt-in:** Kabhi force nahi. Leave = koi penalty nahi.
- **No chat:** League me chat nahi (toxicity ka chance hi nahi)
- **Effort > talent:** Scoring shipped work pe, genius pe nahi

### Seasons (har 3 mahine)
- 12 weekly leagues = 1 season
- Season end pe:
  - Top performers: exclusive badge + theme
  - Sabka league reset (fresh start)
  - Season stats: "Tumne 847 commits kiye, Gold se Diamond pahunche!"

### Backend Requirements
- Central leaderboard server (gateway pe)
- Weekly cron: promotion/demotion calculation
- Anonymous user IDs (privacy)
- Anti-cheat: sudden spike detection (1000 commits ek din me = flag)

### Interaction kaise enhance karega?
1. **Weekly rhythm:** "Monday ko nayi league!" → hafte ki shuruaat me excitement
2. **Loss aversion:** "Main #4 hun, top 3 me jana hai!" → Sunday raat tak coding
3. **Progression fantasy:** Bronze se Legendary ka safar → lambi retention
4. **Duolingo data:** +1/+2/+3% D1/D7/D14 retention, +17% time spent

---

## 📅 Implementation Order (Updated)

| Phase | Kya banega | Kab |
|---|---|---|
| **E.1** | 🔥 Streaks + Bonus Limits + Two-Mode | 🟡 Abhi ban raha hai |
| **E.2** | 📊 Heatmap + ⚔️ Daily Quests + 🏆 Tier A Achievements | ⬜ Next |
| **E.3** | 🏅 Ranks + 🏆 Tier B-G Achievements | ⬜ Uske baad |
| **E.4** | 👥 Squads (git-synced, no backend) | ⬜ Uske baad |
| **E.5** | 🏁 Leagues (backend chahiye) | ⬜ Last (sabse complex) |

**Har phase:** Design approve → Implement → Test → Commit → Push → CI green → Next

---

## 📊 Total Scope Summary

| Mechanic | Items | 
|---|---|
| Daily Quests | 15 daily + 4 weekly = 19 quests |
| Achievements | 37 total (7 tiers) |
| Ranks | 7 ranks, 3x curve |
| Squads | 10 members, weekly goals, celebration-only |
| Leagues | 5 tiers, 30 users each, weekly cycle |

---

*Ye plan `docs/ENGAGEMENT_DETAILED_3-7.md` me saved hai. Founder approval ke baad E.2 se implementation shuru hoga.*
