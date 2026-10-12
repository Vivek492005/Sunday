# 🛡️ SAFE-CHANGE Guidelines — Sunday VS Code Fork

**Rule #0:** Bina `docs/WORKBENCH_DEPENDENCY_MAP.md` dekhe `vscode/src/vs/workbench/` ki koi file mat chhedo.

Ye guidelines Beta.4 incident (commit `2c954f94`) se seekhi gayi hain, jisme `agentSessions.contribution.js` hatane se `IAgentSessionsService` registration gayab hui → `MainThreadChatSessions` ka constructor fail hua → extension host ne `Missing proxy instance MainThreadChatSessions` throw kiya → **poora IDE toot gaya**. Revert: `fdd2495f`.

---

## 1. The Golden Rule: ADD > REMOVE

- ✅ **Naya add karna** (view container, command, menu, theme, webview) — SAFE
- ⚠️ **Existing badalna** (default value, label, color) — CHECK pehle
- 🔴 **Hatana/disable karna** (import, contribution, service) — DANGER, checklist mandatory

## 2. Pre-Change Checklist (har workbench change se pehle)

### Agar sirf ADD kar rahe ho:
1. Kya nayi file hai? → SAFE, aage badho
2. Kya existing file me naya block add ho raha hai (purana code untouched)? → SAFE

### Agar MODIFY kar rahe ho:
1. Kya sirf string/label/color/default badal raha hai? → LOW RISK
2. Kya logic/flow badal raha hai? → MEDIUM RISK, related tests dhundo

### Agar REMOVE kar rahe ho:
**STOP. Ye 6 steps mandatory hain** (detail: `WORKBENCH_DEPENDENCY_MAP.md` §6):

```bash
cd ~/workspace/sunday-product/vscode

# Step 1: File kya-kya register karti hai?
grep -n "registerSingleton" <target-file>
# → Har IXxxService note karo

# Step 2: Bahar kaun use karta hai?
grep -rn "@I<Name>Service" src/vs/workbench --include="*.ts" | grep -v "<target-dir>/"
# → Agar bahar koi hit: STOP. Registration keep karo ya re-home karo.

# Step 3: Kya yehi ekmatra load path hai?
grep -rn "<file>.contribution.js" src/vs/workbench --include="*.ts"
# → Single hit = import hatane se sab kuch jayega

# Step 4: RPC proxy coupling check
grep -rn "extHostNamedCustomer" src/vs/workbench/api/browser/mainThread*.ts | grep -i "<area>"
# → Agar proxy ko tumhari service chahiye: proxy tootega

# Step 5: Koi registerSingleton bypass toh nahi?
grep -rn "serviceCollection.set(I<Name>" src/vs/workbench/electron-browser/desktop.main.ts
# → Kuch services manual register hoti hain, grep miss kar sakta hai

# Step 6: tsc PASS ≠ SAFE
# TypeScript compile hone se runtime registration prove nahi hoti.
# Asli proof: built IDE ke startup logs me "Cannot instantiate" / "Missing proxy" absent hona chahiye.
```

## 3. Danger Zones (kabhi mat chhedo bina senior review ke)

| Area | Kyun dangerous hai |
|---|---|
| `api/browser/mainThread*.ts` | Extension host proxies — ek toota toh sab toota |
| `services/extensions/` | Extension host lifecycle |
| `platform/instantiation/` | DI container — sab kuch ispe khada hai |
| Chat/agent `registerSingleton` | Proxy constructors inko inject karte hain |
| `workbench.common.main.ts` imports | Har import ek registration chain hai |

## 4. Safe Zones (khul ke badlo)

| Area | Examples |
|---|---|
| Naye view containers | `sunday-home`, `sunday-agent` jaise |
| Naye commands/menus | `package.json` contributions |
| Theme files | `extensions/theme-sunday/` |
| `product.json` branding | Names, URLs, gallery (keys mat hatao!) |
| Naye webviews/panels | Guide, streak, home |
| Extension code (`packages/ext-agent/`) | Tumhara apna code — full control |

## 5. product.json Rules

- ✅ Values badlo (names, URLs, colors)
- 🔴 Keys mat hatao (Beta.1 ka black-screen incident isi se hua tha)
- ⚠️ Gallery URL badalne se pehle extension install test karo

## 6. Verification Ladder (har change ke baad)

1. `npx tsc --noEmit` — compile (necessary, not sufficient)
2. `grep` checks (upar wale 6 steps)
3. **Built artifact me verify** — Linux tarball khol ke andar dekho
4. **Startup logs check** — "Cannot instantiate" / "Missing proxy" absent
5. Tabhi commit → push → CI → release

---

**Yaad rakho:** Beta.4 me tsc clean tha, phir bhi production toota tha. Compile success ≠ runtime success.
