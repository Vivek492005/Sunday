# Sunday Streaks — Detailed Working Plan

**Version:** 1.0 | **Date:** 2026-10-08 | **Status:** Implementing

---

## 1. Kya hai Streak System?

Roz coding karne pe **streak** badhta hai (Duolingo jaisa 🔥). Lambi streak = **free bonus AI requests**. Simple.

---

## 2. Streak Day kaise count hoga?

**Sirf app kholna count NAHI hoga.** Ye sab me se koi ek karo to "streak day" milega:

| Action | Minimum |
|---|---|
| Git commit | 1 commit push karo |
| Active editing | 30+ minute code likho |
| PR merge | 1 PR merge karo |
| AI task complete | 1 AI agent task successfully complete karo |

**Example:**
- Monday: 2 commits kiye → ✅ Streak Day 1
- Tuesday: 45 min coding → ✅ Streak Day 2 (streak = 2)
- Wednesday: Sirf app khola, kuch nahi kiya → ❌ Streak tootegi (agar freeze nahi hai)

---

## 3. Streak Freeze (safety net)

**Problem:** Ek din miss hua to saari mehnat waste? Nahi!

**Solution:**
- Har 7-day streak pe **1 Freeze** milta hai (max 3 store kar sakte ho)
- Agar ek din miss ho gaya aur freeze hai → **auto-use**, streak bach jayegi
- Notification milega: "🛡️ Streak Freeze used! Your 12-day streak is safe."

**Example:**
```
Day 1-7:   Coding ki → Streak 7, +1 Freeze earned 🛡️
Day 8-14:  Coding ki → Streak 14, +1 Freeze earned 🛡️ (total 2)
Day 15:    Miss ho gaya → Freeze auto-used → Streak 15 bacha! (1 freeze left)
Day 16:    Coding ki → Streak 16
```

---

## 4. Vacation Mode (chhutti pe bhi safe)

- Saal me **14 din** tak streak pause kar sakte ho
- Vacation me streak na badhegi, na tootegi — freeze rahegi
- Command: `Sunday: Enable Vacation Mode` → kitne din? → done
- Wapas aao to wahi se continue

---

## 5. 🎁 Bonus Rate Limits (tumhara idea!)

Streak lambi hogi to **extra free AI requests** milenge:

| Streak | Bonus | Free tier total |
|---|---|---|
| 0-6 din | +0 | 200/day |
| **7 din** (1 hafta) | **+100/day** | **300/day** 🎉 |
| **14 din** (2 hafte) | **+200/day** | **400/day** 🎉🎉 |
| **30 din** (1 mahina) | **+500/day** | **700/day** 🎉🎉🎉 |

### Important rules:
- **Bonus sirf us din milega jab streak active hai.** Kal streak tooti to parson se wapas 200/day.
- **Paid plans pe bhi stack hoga:**
  - Basic (500) + 30-day streak (500) = **1000/day**
  - Pro (3000) + 30-day streak (500) = **3500/day**
- Usage dashboard me alag se dikhega: `Base: 200 + Streak Bonus: 100 = 300`

### Example journey:
```
Week 1:  Roz coding → Day 7 pe 🎉 "Streak Bonus unlocked: +100/day!"
Week 2:  Continue → Day 14 pe 🎉🎉 "+200/day!"
Month 1: Continue → Day 30 pe 🎉🎉🎉 "+500/day! You're a legend!"
Day 31:  Miss ho gaya, freeze nahi tha → Streak reset → wapas 200/day
         (Dard hoga, lekin phir se shuru karne ka motivation bhi!)
```

---

## 6. UI — User ko kya dikhega?

### Status Bar (hamesha visible)
```
🔥 12    ← current streak
```
Click karne pe streak panel khulega.

### Streak Panel
```
┌─────────────────────────────┐
│  🔥 12 Day Streak           │
│  Longest: 28 days           │
│                             │
│  🛡️ Freezes: 2/3            │
│                             │
│  Next milestone:            │
│  ████████░░ 14 days         │
│  +200 bonus in 2 days!      │
│                             │
│  [Enable Vacation Mode]     │
└─────────────────────────────┘
```

### Notifications
- **Milestone hit:** "🎉 7-day streak! +100 bonus requests/day unlocked!"
- **Freeze earned:** "🛡️ Streak Freeze earned! (2/3)"
- **Freeze used:** "🛡️ Freeze used — your streak is safe!"
- **At-risk (8 PM):** "🔥 Your 12-day streak is at risk! Code a little to keep it alive." (sirf agar streak ≥ 3, din me max 1 baar, disable kar sakte ho)

### Settings
- `sunday.engagement.streaksEnabled` — on/off (default: on)
- `sunday.engagement.streakNotifications` — notifications on/off (default: on)

---

## 7. Technical Design

### Data Storage (local-first, private)
```
~/.sunday/engagement/
  ├── activity.json    ← daily activity log
  └── streak.json      ← streak state
```

**activity.json:**
```json
{
  "2026-10-08": { "commits": 2, "editMinutes": 45, "prsMerged": 0, "aiTasks": 3, "testsRun": 5 },
  "2026-10-07": { "commits": 1, "editMinutes": 20, "prsMerged: 1, "aiTasks": 0, "testsRun": 2 }
}
```

**streak.json:**
```json
{
  "current": 12,
  "longest": 28,
  "lastActiveDate": "2026-10-08",
  "freezesAvailable": 2,
  "freezesEarnedTotal": 5,
  "vacationDaysUsed": 3,
  "vacationUntil": null
}
```

### Gateway Integration
```
Client → GET /me/usage/today
  Headers: { streak-days: 12 }

Server response:
{
  "baseQuota": 200,
  "streakDays": 12,
  "streakBonus": 100,
  "totalQuota": 300,
  "used": 45,
  "remaining": 255
}
```

### Anti-Gaming
- Sirf meaningful actions count hongi (commit/edit/PR/AI task)
- Server v1 me client ke streak pe trust karega
- v2 me signed activity attestations aayenge (tamper-proof)

---

## 8. Privacy

- **Sab kuch local:** Activity data tumhare computer pe, server pe nahi
- **Server ko sirf:** `streakDays` number jata hai (12), details nahi
- **Opt-out:** Ek setting se poora system band kar sakte ho
- **No telemetry:** Koi tracking, koi analytics company ko data nahi

---

## 9. Implementation Status

- [x] Plan finalized
- [ ] Activity tracking engine
- [ ] Streak engine (freeze, vacation, at-risk)
- [ ] Gateway bonus integration
- [ ] UI (status bar, panel, notifications)
- [ ] Tests
- [ ] Push + CI

**Worker currently implementing. ETA: complete hote hi report.**
