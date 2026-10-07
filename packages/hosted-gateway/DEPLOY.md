# Sunday Hosted Gateway — Deployment Guide

Zero-config AI for Sunday IDE users. Users sign in with GitHub → AI works immediately. No API keys to copy.

## How it works

```
Sunday IDE → GitHub sign-in → OAuth token → sundayd → api.sunday.dev → OpenRouter/Groq
                                                                    (YOUR provider keys)
```

- **Auth**: GitHub / Google / Microsoft OAuth token (from the IDE sign-in)
- **Quota**: 200 requests/day per user (configurable)
- **Abuse**: per-minute rate limits + IP allowlist + audit log (already built)

## Deploy (Railway — ~5 min)

1. **Push this repo** (the `Dockerfile` + `railway.json` are in `packages/hosted-gateway/`)
2. **Railway dashboard** → New Project → Deploy from GitHub → select `Sunday` repo
3. Set **Root Directory** to `/` (the Dockerfile path is configured in `railway.json`)
4. **Variables** tab → add (see `.env.example` for the full list):
   ```
   OPENROUTER_API_KEY=<your key>      # or GROQ_API_KEY — at least one
   SUNDAY_HOSTED_SOCIAL_AUTH=1
   SUNDAY_HOSTED_DAILY_QUOTA=200
   SUNDAY_HOSTED_HOST=0.0.0.0
   ```
5. **Deploy** → Railway gives you a URL like `https://sunday-api.up.railway.app`
6. **Point the IDE at it**: set the default API URL
   - Option A (recommended): change `SUNDAY_DEFAULT_API_URL` in
     `packages/gateway/src/providers.ts` to your Railway URL, rebuild
   - Option B: users set `SUNDAY_API_URL` env var (for self-hosting)

## Cost estimate

| Users | Requests/day | Model | Est. monthly cost |
|-------|-------------|-------|-------------------|
| 100   | ~5,000      | Llama 3.3 70B (Groq) | ~$10–30 |
| 1,000 | ~50,000     | Llama 3.3 70B (Groq) | ~$100–300 |

Groq's Llama is cheapest. OpenRouter gives more model choice at higher cost.
Start with Groq, add OpenRouter as failover.

## Power users (BYOK)

Users who set `OPENROUTER_API_KEY` / `GROQ_API_KEY` locally bypass the
hosted gateway entirely — unlimited, on their own quota. The router
prefers explicit `openrouter:` / `groq:` model refs.

## Monitoring

- `GET /health` → `{ ok: true }` (Railway healthcheck)
- Audit log (stdout) → every request with GitHub login, model, tokens, status
- Watch for `quota_exceeded` (429) spikes = time to raise quota or add paid tier

## Security notes

- Provider keys live ONLY on the server — never in the IDE, never in git
- OAuth tokens are verified against the provider's userinfo endpoint (5-min cache)
- The gateway exposes text chat ONLY — no tools, no shell, no file access
- Token never logged (audit uses `gh:<id> (<login>)` fingerprint)
