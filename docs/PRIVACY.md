# Sunday Privacy

## What leaves the machine, and when

Sunday is local-first by construction. Network traffic happens only in
these cases — all of them caused by an explicit user action:

1. **Model provider API calls** — when you run a chat turn, an inline
   completion, an inline edit, a commit-message generation, or any other
   agent task, sundayd calls your configured provider (OpenRouter and/or
   Groq, API-first per the build decisions). The request carries the prompt,
   conversation/tool context the model needs, and nothing else. API keys
   come from your environment (`OPENROUTER_API_KEY` / `GROQ_API_KEY`) —
   your keys, your accounts (BYOK). No Sunday-operated server is in the
   path; there is no Sunday account and no Sunday cloud.
2. **MCP servers you configured** — local stdio servers you listed in
   `.sunday/mcp.json`; a Streamable-HTTP MCP server you configured would
   be contacted when one of its tools runs. Your config, your servers.
3. **The agent browser (opt-in)** — only when `sunday.browser.enabled` is
   true and the agent uses a `browser_*` tool does Chromium traffic leave
   the machine, to the pages the agent visits.
4. **Commands the agent runs** — `run_terminal` with sandbox mode `off`
   runs on your host with your network; `docker`/`bubblewrap` modes
   disable networking entirely (see `docs/SANDBOX.md`).

## What never happens

- **No telemetry.** There is no analytics, usage reporting, or crash
  reporting — nothing phones home, ever.
- **No update checks.** Sunday never checks for new versions on its own.
- **No license/activation calls.** There is no license server.
- **Idle means silent.** Booting sundayd, opening the extension, indexing
  the workspace, loading skills/rules/MCP config — none of this touches
  the network.

This is enforced by test, not just by convention: see below.

## What's stored where

Everything lives on your machine:

| Location | Contents |
|---|---|
| `~/.sunday/` | Sessions, orchestration state (`orchestrations/`), browser session media (`browser-sessions/`), MCP user config, memory/skills data (`remember` tool), checkpoints. |
| `<workspace>/.sunday/` | Workspace MCP config (`mcp.json`), orchestration artifacts. |
| Your shell environment | API keys (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `SUNDAY_MCP_SECRET_*`); never written to disk by Sunday. |

File tools are confined to the workspace root; `remember`-style memory
refuses to store secrets.

## Local-only mode

You can run Sunday with no hosted provider at all:

- Point the gateway at a local model server (Ollama or any
  OpenAI-compatible endpoint on `localhost`) — chat, edit, and agent
  turns work end to end with zero traffic leaving the machine.
- Everything else degrades gracefully rather than phoning home: with no
  provider keys configured, model calls fail with a clear "missing API
  key" error instead of falling back to some default cloud.

What degrades offline: nothing phones home regardless, so "offline" is
the default posture — only the provider calls you trigger need the
network, and with a local model even those stay on loopback.

## Evidence: the idle-silent test

`packages/sundayd/src/privacy-idle.test.ts` boots the real daemon surface
— the production OpenRouter/Groq provider registry, the full Part-A tool
surface, the MCP hub with an empty workspace config — with `globalThis.fetch`
stubbed by a recording spy, then asserts **zero** fetch calls:

1. on daemon boot with no user task (letting timers settle), and
2. after a non-model RPC round-trip (`session/list`).

The only network surface in the daemon is `fetch` in
`packages/gateway/src/openai-compatible.ts` (provider chat/completions),
which fires exclusively from user-initiated model calls. If a future
change adds any startup/telemetry/update-check fetch, this test fails.
