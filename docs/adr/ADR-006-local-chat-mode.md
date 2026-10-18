# ADR-006: Optional local chat mode (Ollama)

**Status:** Accepted

**Context:** ADR-004 decided v1 is API-first (OpenRouter + Groq), with "no local model by default" and Ollama as an optional fallback on the roadmap. Since then, two things shipped: the Ollama autocomplete slice (FIM via the local daemon) and a real demand signal — users hitting provider limits want a local option. F14 implements that option for *chat* (Ask, Explain, Inline-edit).

**Decision:** Local chat is **opt-in and additive**. It does not change ADR-004's default:

- API-first remains the default path. Nothing changes for users who never touch local settings.
- `sunday.localModel.chat` (env: `SUNDAY_LOCAL_CHAT=1`) enables local-first routing for three single-shot chat modes: **Ask**, **Explain**, **Inline-edit**. The router tries the user's Ollama server first and degrades to the existing cloud fallbacks when the daemon is down (logged + visible, per the F3 honest-routing rules).
- The **full agent loop** on a local model is *capability-gated*: a startup/on-demand probe (tool-call format, JSON adherence, edit apply) must pass before `localModel.agentCapable` is set. Small models are unreliable agents; we gate instead of pretending.
- **Privacy routing:** `privacy: 'local-only'` pins a request to the Ollama provider. The router throws `LocalOnlyUnavailableError` rather than ever sending such a request to a cloud provider — no silent fallback, by construction.

**What ADR-004 still governs (unchanged):**
- No model weights are bundled with the installer.
- No local inference runs unless the user explicitly opts in.
- Onboarding stays zero-config (Sunday hosted gateway).

**What this ADR adds (scope clarification, not a supersede):**
- "No local model *by default*" ≠ "no local model *ever*". The local path exists, is user-owned (their Ollama, their hardware), and is fenced by the probe + privacy guarantees above.
- Model discovery reads the local `/api/tags`; nothing is downloaded or uploaded by Sunday itself.

**Consequences:**
- (+) Offline-capable Ask/Explain/Inline-edit for users with Ollama; zero cloud cost and zero data egress for those turns.
- (+) Privacy-sensitive files can be constrained to local-only routing.
- (−) Local model quality varies by what the user installed; the probe + honest capability table keep expectations truthful.
- (−) First-run probe adds a few seconds when local chat is enabled (skipped entirely when disabled).

**Revisit when:** A bundled/embedded local runtime is proposed (would reopen installer-size and GPU questions), or when the probe's pass criteria need tightening from F12 eval data.
