# Provider setup — OpenRouter + Groq (BYOK)

Sunday is **bring-your-own-key (BYOK)**: you supply your own API keys from
the providers; Sunday never ships keys, proxies your traffic, or bills you.
All provider calls go straight from `sundayd` on your machine to the
provider's API.

## How keys are actually read (the real mechanism)

`packages/gateway/src/providers.ts` — `requireApiKey()`:

- OpenRouter: **`OPENROUTER_API_KEY`**
- Groq: **`GROQ_API_KEY`**

Keys come from the **process environment** of the VS Code process that
spawns `sundayd`. There is no settings UI and no SecretStorage path for
provider keys today — if the env var is missing, the provider throws
`missing API key: set OPENROUTER_API_KEY in the environment` and the
router surfaces it visibly instead of failing silently.

(MCP server secrets are different: those go through VS Code SecretStorage
via `Sunday MCP: Store Secret…` and are passed to `sundayd` as
`SUNDAY_MCP_SECRET_*` env vars. Don't mix the two up.)

## Step-by-step: OpenRouter

1. Create an account at <https://openrouter.ai> and open **Keys**
   (<https://openrouter.ai/settings/keys>). Create a key.
   - Free-tier models exist, but many requests need a small prepaid
     credit; free models have stricter rate limits (see below).
2. Make the key visible to VS Code. On **Windows**, the reliable way is to
   set a **user environment variable** before launching VS Code:
   - Settings → search "environment variables" → *Edit environment
     variables for your account* → New: name `OPENROUTER_API_KEY`,
     value = your key → OK.
   - **Close and re-launch VS Code** (it must inherit the new variable;
     launching from a terminal that already has it set also works).
3. Verify: open the Sunday chat panel and send any message. If the key is
   missing you'll get `missing API key: set OPENROUTER_API_KEY in the
   environment` in the chat error — fix the env var and run
   `Sunday: Restart Sidecar` (env changes need a sidecar restart).

## Step-by-step: Groq

1. Create an account at <https://console.groq.com>, open **API Keys**, and
   create a key. Groq's free tier is generous for chat models (rate limits
   are per-model, per-minute/per-day — check the console's Limits page).
2. Same as OpenRouter: set a user env var **`GROQ_API_KEY`** on Windows and
   re-launch VS Code.
3. Verify the same way. The router tries providers in registry order and
   fails over on 429/5xx — you can configure one key, both, or rely on a
   single provider.

## Default models

Starting points (`packages/gateway/src/providers.ts`; override via Sunday
settings):

| Provider | Model | Notes |
|---|---|---|
| OpenRouter | `meta-llama/llama-3.3-70b-instruct` | General chat, tool use |
| OpenRouter | `qwen/qwen-2.5-coder-32b-instruct` | Code + native FIM (ghost-text autocomplete) |
| Groq | `llama-3.3-70b-versatile` | Fast chat, tool use |

Free-tier availability changes over time; the router surfaces provider
4xx/429 visibly (§10.6 of the design doc) instead of failing silently.

## Rate limits / 429 behavior

The gateway has a per provider+model sliding-window limiter
(`packages/gateway/src/scheduler.ts`) and parks a provider+model in
cooldown after a 429 (honoring `Retry-After`). On exhaustion the router
fails over to the next provider in order; when all are exhausted, the
chat UI shows a visible **Relay** marker with auto-resume. This is normal
on free tiers — it is not an error to report.

## Local model for completions (Ollama)

**Status: implemented (autocomplete only).** When `sunday.localModel.enabled`
is `true`, ghost-text completions try a local Ollama model first and fall
back to the API provider chain silently on any failure. No API keys are
needed for the local path — this is the rate-limit survival story: your
highest-frequency model calls keep working even when providers 429 you.

This is **autocomplete only** in this slice: the chat/agent loop still uses
OpenRouter/Groq. Local chat is a follow-up slice (see
`docs/LOCAL_MODEL_PLAN.md`).

### Setup

1. Install Ollama: <https://ollama.com> (Windows/macOS/Linux), then start it
   (`ollama serve` on Linux; the desktop apps start it automatically).
2. Pull the completion model (small, fast, FIM-trained coder):
   ```sh
   ollama pull qwen2.5-coder:1.5b
   ```
3. In VS Code: Settings → search `sunday.localModel.enabled` → check it
   (default off).
4. Restart the Sunday sidecar when prompted (the flag is stamped at spawn).

Optional: point at a non-default server with the `OLLAMA_BASE_URL`
environment variable (default `http://localhost:11434`); make it visible
to VS Code the same way as provider keys above.

### What happens when Ollama isn't running

**Nothing user-visible.** The daemon tries the local model with a 3s
timeout; on any failure (not installed, not running, model not pulled,
timeout) it falls through to your configured API providers with no error
shown. Ghost text just keeps working via the cloud.

Every uncached completion emits a structured metric line on the daemon's
diagnostics channel (stderr), so the fallback rate is observable:

```json
{"metric":"sunday.completion.provider","provider":"ollama"}
{"metric":"sunday.completion.provider","provider":"api"}
```

Tail the sidecar output and count the ratio to see how often you're
serving locally vs. falling back.

## Security notes for key handling

- Keys are read from the environment and **never written** to session
  files, checkpoints (`~/.sunday/…`), logs, or the repo. Nothing in the
  repo contains a real key (verified: no `sk-` secrets outside test
  fixtures and `mime-db`).
- Don't paste keys into chat, `mcp.json`, or workspace files — they get
  synced/copied. Env vars (provider keys) and SecretStorage (MCP secrets)
  are the only supported homes.
- If a key leaks, revoke it in the provider console and rotate; Sunday
  needs only a sidecar restart to pick up the new value.
