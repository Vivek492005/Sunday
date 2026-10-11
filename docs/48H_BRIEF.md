# Sunday — 48-Hour Deep-Dive Brief
**Period:** Oct 6-8, 2026 | **For:** Co-founder review
**Stats:** 111 commits | ~42,000 lines added | ~3,100 lines removed

---

## EXECUTIVE SUMMARY

Pichle 48 ghanto me Sunday me **5 major categories** me kaam hua:

1. 🔐 **Security & Anti-Abuse** — Account-switch limits, Admin gateway
2. 🎮 **User Engagement** — Streaks, gamification master plan
3. 💳 **Billing Strategy** — Paddle decision, payment architecture
4. 🔧 **CI/CD Fixes** — 5 Windows CI failures fixed, fast test pipeline
5. 📦 **Features & Docs** — GitHub integration, 18 competitive features, legal docs

---

## 1. 🔐 SECURITY & ANTI-ABUSE

### 1a. Account-Switch Rate Limiting
**Commit:** `059ca326` | **Status:** ✅ Pushed, live on gateway

**Problem:** Free tier ka abuse — ek user multiple Google/Microsoft accounts bana ke unlimited free requests le sakta tha.

**Solution:**
- Per machine, per provider, rolling 24 hours: **max 2 distinct accounts**
- Same account se re-login = count nahi hota (switch nahi hai)
- 3rd account → **429 denied** with friendly message + upgrade option
- Paid users bypass karte hain (unhe rokne ka koi matlab nahi)

**Technical:**
- Server: `signin_log.json` (local), `checkAccountSwitchLimit()`, `recordSignin()`
- Client (Google + Microsoft): `machine_id` bhejta hai, 429 pe "View Plans" offer karta hai
- Privacy: machine ID ko HMAC-hash karke store karne ka plan (abhi raw hai)

**Tests:** 186/186 gateway + 30/30 auth extension pass

---

### 1b. Separate Admin Login Gateway
**Commit:** `b432119c` | **Status:** ✅ Pushed, live on gateway

**Problem:** Founder (tum) ko sab restrictions se bypass chahiye tha — testing aur management ke liye.

**Solution:** Alag admin endpoint, user login se completely separate.

| | User Login | Admin Login |
|---|---|---|
| Endpoint | `POST /auth/session` | `POST /admin/login` |
| Kaun login kar sakta | Koi bhi | Sirf allowlist emails |
| Account-switch limit | ✅ Lagta hai | ❌ Bypass |
| Daily quota | ✅ Lagta hai | ❌ Bypass (unlimited) |
| Session expiry | Normal | 8 hours (security) |

**Security features:**
- Allowlist env var se: `SUNDAY_ADMIN_EMAILS` (currently sirf tumhari ID)
- Koi aur try kare → **403**, ye reveal nahi hota ki kaun admin hai
- Fail-closed: env var set nahi to koi admin login nahi
- Rate limit: 5 attempts/min per IP (brute force protection)
- Audit log: har attempt logged (success + failure), emails hashed
- Admin JWT ka alag issuer (`sunday-admin`) — user session me kabhi validate nahi hoga
- Webhook signatures aur admin-key checks bypass **nahi** hote (defense in depth)

**Tests:** 28/28 new + 214/214 total pass

---

## 2. 🎮 USER ENGAGEMENT (GAMIFICATION)

### Research
Duolingo, LeetCode, GitHub, Codewars, Habitica ka deep research kiya. Key findings:
- Duolingo streaks + leagues = sabse powerful retention mechanics
- GitHub ne 2016 me streak counter **hataya** tha (log fake activity karne lage the)
- Codewars ka 3x anti-farming curve = gold standard for skill ranks

### 2a. Coding Streaks (IMPLEMENTED)
**Commits:** `26833d89`, `94423919` | **Status:** ✅ Pushed, CI me hai

**Kaise kaam karta hai:**
- Roz coding karo → streak badhta hai (Duolingo jaisa 🔥)
- **Streak day** = 1 commit YA 30+ min coding YA 1 PR YA 1 AI task (sirf app kholna count nahi!)
- 🛡️ **Streak Freeze:** Har 7 din pe 1 freeze milta hai (max 3). Miss → auto-bachao.
- 🏖️ **Vacation Mode:** Saal me 14 din pause, streak safe.

**🎁 Bonus Rate Limits (tumhara idea!):**

| Streak | Bonus/day | Free tier total |
|---|---|---|
| 7 din | +100 | 300/day |
| 14 din | +200 | 400/day |
| 30 din | +500 | 700/day |

- Paid plans pe stack hota hai: Pro (3000) + 30-day streak (500) = **3500/day**
- Self-reinforcing loop: Roz code karo → zyada AI requests → aur banao → roz code karo

**🔇 Two-Mode Design (tumhara requirement!):**
- **Passive mode** (normal VS Code use): Sirf silent streak tracking. Koi popup, koi prompt, koi disturbance nahi. Bas status bar me `🔥 12`.
- **Active mode** (AI agents use): Full engagement — quests, achievements, celebrations.
- Auto-detect: Pehli AI use pe active mode on.

**Technical:**
- Client: `packages/ext-agent/src/engagement/` (activity tracking, streak engine, UI, two-mode)
- Gateway: `streakBonus.ts` (tiers), quota system me bonus band, `X-Sunday-Streak-Days` header
- Data local: `~/.sunday/engagement/` (private, server ko sirf number jata hai)
- Tests: 150+ (46 ext-agent + 37 gateway + integration)

### 2b. Engagement Master Plan (DESIGNED, not yet implemented)
**Docs:** `ENGAGEMENT_MASTER_PLAN.md` (v3.0), `ENGAGEMENT_DETAILED_3-7.md`

**7 mechanics planned:**

| # | Mechanic | Detail | Status |
|---|---|---|---|
| 1 | 🔥 Streaks | Upar dekho | ✅ Done |
| 2 | 📊 Heatmap | GitHub green squares, IDE ke andar | 📋 Planned |
| 3 | ⚔️ Daily Quests | 19 quests designed (easy/med/hard + weekly). Eg: "5 AI suggestions accept karo" | 📋 Planned |
| 4 | 🏆 Achievements | **37 achievements**, 7 tiers. Rare wale real features unlock karenge! | 📋 Planned |
| 5 | 🏅 Ranks | 7 ranks (Novice→Master), Codewars-style 3x anti-farming curve | 📋 Planned |
| 6 | 👥 Squads | 10-member teams, celebration-only (koi guilt nahi!) | 📋 Planned |
| 7 | 🏁 Leagues | Weekly 30-user leagues, Duolingo model | 📋 Planned |

**Implementation order:** E.1 Streaks (done) → E.2 Heatmap+Quests+Achievements → E.3 Ranks → E.4 Squads → E.5 Leagues

---

## 3. 💳 BILLING STRATEGY

### Paddle Decision (FINAL)
**Status:** 📋 Decided, implementation deferred (2-3 din baad)

**Cashfree vs Paddle analysis ke baad Paddle chosen. Kyun?**
- Paddle **Merchant of Record** hai — saara global tax/GST woh handle karta hai
- Cashfree me tumhe khud GST registration + invoicing + monthly filing karni padti
- Target: India first (Paddle UPI support karta hai), phir global

**Pricing (GST-inclusive):**
| Plan | Price/mo | Requests/day | Agents | Browser |
|---|---|---|---|---|
| Free | ₹0 | 200 | 1 | ❌ |
| Basic | ₹149 | 500 | 2 (sequential) | 5/day |
| Smart | ₹349 | 1,200 | 3 (sequential) | 15/day |
| Pro | ₹799 | 3,000 | 4 (parallel) | Unlimited |

**Docs:** `docs/PAYMENT_ARCHITECTURE.md` (Paddle-based design)
**Paddle setup manual:** 7-phase guide ready (account → verification → products → API keys → webhooks → sandbox → go live)

---

## 4. 🔧 CI/CD FIXES

### 5 Windows CI Failures Fixed
Pichle 48 ghante me Windows CI 5 baar fail hua, har baar root cause fix kiya:

| # | Problem | Root Cause | Fix |
|---|---|---|---|
| 1 | `agents-md` test fail | `path.relative()` Windows pe backslash deta hai | Path normalize kiya |
| 2 | Secret scan fail | Test me fake `ghp_...` token tha | Non-secret-looking token use kiya |
| 3 | Permission tests fail | Unix `0o600` Windows pe kaam nahi karta | Windows pe skip kiya |
| 4 | `githubRepos.test.ts` fail | Test me hardcoded `/` tha | `path.sep` use kiya |
| 5 | Product tests fail (all OS) | Tests build se pehle chal rahe the | Build-then-test order fix |

### New: Fast Cross-Platform Test CI
**File:** `.github/workflows/product-tests.yml`
- Har push pe Linux + macOS + Windows pe tests (~5 min)
- Pehle 40-min full IDE build ka wait karna padta tha
- Ab Windows bugs 5 min me pakde jate hain

**Result:** Product tests **3/3 GREEN** ✅ (Linux ✅ Mac ✅ Windows ✅)

---

## 5. 📦 FEATURES & DOCS

### GitHub Integration
- **One-click repo import:** VS Code ke built-in GitHub auth se koi bhi repo (private/public) select karke clone karo
- **GitHub sign-in option** account UI me (Google/Microsoft ke saath)
- Commands: `sunday.github.cloneRepo`, `sunday.github.signIn`, `sunday.github.signOut`

### 18 Competitive Features (shipped)
Cloud task queue, Best-of-N, Artifacts, Mission Control, Scheduled tasks, AGENTS.md, Style inference, Project templates, Agent modes, Cross-project learning, PR automation, Design-to-code, Onboarding wizard, NL terminal commands, Voice input, Usage dashboard, Encrypted session sync, Skills marketplace

### Legal Docs
- Terms of Service + Privacy Policy (docs + landing page)
- Footer links added

### Gateway Live & Tested
- **URL:** sunday-final-ide.onrender.com
- Load test: 0% errors at 50 concurrent, ~10 users comfortable
- Google OAuth published, zero-config AI flow working

---

## 📊 BY THE NUMBERS

| Metric | Value |
|---|---|
| Commits (48h) | 111 |
| Lines added | ~42,000 |
| Lines removed | ~3,100 |
| Tests passing | 1,885+ (product) |
| CI platforms green | 3/3 (Linux/Mac/Windows) |
| New API endpoints | 5 (`/admin/login`, `/admin/logout`, `/admin/me`, `/me/usage/today`, streak headers) |
| New docs | 8 (engagement plans, payment arch, terms, privacy) |

---

## ⏳ IN PROGRESS / PENDING

| Item | Status |
|---|---|
| Sunday IDE full build (streaks wala) | 🟡 CI me chal raha hai (~40 min) |
| Beta.2 release (streaks ke saath) | ⬜ CI green ke baad |
| Paddle implementation | ⬜ 2-3 din baad (user ne kaha) |
| E.2 Engagement (heatmap/quests) | ⬜ Streaks ke baad |
| Screen-reader accessibility pass | ⬜ Human task |
| npm publish (@sunday/cli) | ⬜ User-side pending |

---

*Generated: 2026-10-08 | Sunday Project*
