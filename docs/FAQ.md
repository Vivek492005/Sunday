# Sunday FAQ

## Is my code sent anywhere?

Your code is sent to the AI provider you configured (OpenRouter or Groq) as part of the agent's requests — that's how the AI sees your code to help you. Your code is **never** used for training. Secrets are redacted before any content reaches a provider (SEC-03). You can run a packet capture during a session to verify exactly what leaves your machine.

## Why no local model yet?

v1 is API-first by design (see ADR-004): no multi-GB downloads, no GPU requirements, fast onboarding. Local Ollama support is on the roadmap — starting with autocomplete, then full agent-loop support.

## How is this different from Copilot / Cursor?

- **Open source** (Apache-2.0) — Copilot and Cursor are proprietary.
- **Hierarchical orchestration** — parallel agents with context-centric decomposition, not just one chat loop.
- **Visible security** — published STRIDE threat model, taint tracking, secret redaction.
- **No vendor lock-in** — bring your own OpenRouter/Groq keys; switch models freely.

## Do I need API keys?

Yes — you bring your own OpenRouter and/or Groq API keys. Keys are stored as environment variables only, never in files.

## Which OS is supported?

Windows is fully supported today. Linux and macOS builds are available as beta assets on the GitHub release.

## Is the JetBrains plugin ready?

The JetBrains plugin exists (Kotlin, 19 tests) but is not yet at "stable" — see the Path-to-10 plan for its completion criteria.

## How do I install the extension manually?

Download the `.vsix` from the GitHub release, then in VS Code: Extensions view → `...` → Install from VSIX.
