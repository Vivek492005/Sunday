# ADR-004: API-first with no bundled local model

**Status:** Accepted

**Context:** The original vision included local-model fallback (Ollama) so the agent survives provider rate limits. The question was whether v1 ships with a bundled local model or goes API-first via hosted providers (OpenRouter + Groq).

**Decision:** v1 is API-first: OpenRouter + Groq, no model weights bundled, no local inference by default. Ollama remains an optional fallback on the roadmap, not the default path.

**Alternatives considered:**
- *Bundle a small local model*: Rejected for v1 — multi-GB downloads destroy the installer UX; the user's explicit call was "no model load on my PC."
- *Ollama-required*: Rejected — adds a heavyweight external dependency to onboarding.

**Consequences:**
- (+) Small installer, fast onboarding, no GPU requirements.
- (+) Rate-limit resilience comes from provider routing, not local compute.
- (−) Offline use is impossible in v1; provider outages are user-visible.
- (−) The original "never runs out" differentiator is weakened until local support ships.

**Revisit when:** Local-model support ships (planned minimal slice: Ollama-backed autocomplete) — at that point this ADR is superseded by a new one covering the hybrid model.
