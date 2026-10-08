# @sunday/hosted-gateway

Optional hosted gateway for Sunday (Phase 8) — for users **without their own
provider keys**.

The operator runs this server with *their* provider keys
(`OPENROUTER_API_KEY` / `GROQ_API_KEY`). Remote clients authenticate with
**gateway-issued** API keys and get an OpenAI-compatible **text chat** API —
nothing else. There is no shell, no file access, no tool execution on this
surface, by construction.

## Quick start

```bash
# One API key (id:secret). Bind defaults to 127.0.0.1 — set
# SUNDAY_HOSTED_HOST=0.0.0.0 only behind your own TLS terminator.
SUNDAY_HOSTED_KEYS="alice:s3cret1,bob:s3cret2" \
  npx sunday-hosted-gateway --port 8080
```

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer s3cret1" \
  -H "Content-Type: application/json" \
  -d '{"model":"openrouter:meta-llama/llama-3.3-70b-instruct",
       "messages":[{"role":"user","content":"Hello!"}]}'
```

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | no | Liveness probe (`{"ok":true}`) |
| `GET` | `/v1/models` | yes | OpenAI-style model list |
| `POST` | `/v1/chat/completions` | yes | Chat completion; `stream:true` gives SSE |

`POST /v1/chat/completions` accepts `model`, `messages`, `temperature` (0–2),
`max_tokens` (clamped to the cap), and `stream`. Requests containing `tools`,
`tool_choice`, `functions`, or `function_call` are rejected with `400` —
**tool use is forbidden**. If the model emits tool calls anyway, those chunks
are dropped; only text is returned.

## Abuse controls

1. **API key auth** — `Authorization: Bearer <secret>`. Compared in
   constant time. Audit logs reference keys by truncated SHA-256 fingerprint,
   never the secret.
2. **Rate limiting** — per-key token bucket on two dimensions: requests/min
   (`SUNDAY_HOSTED_RPM`, default 60) and estimated input tokens/min
   (`SUNDAY_HOSTED_TPM`, default 100000). Exceeding either returns `429` with
   a `Retry-After` header.
3. **Request limits** — max body bytes, max message count, max chars per
   message, and a hard `max_tokens` cap (client values are clamped, not
   rejected).
4. **Model allowlist** — `SUNDAY_HOSTED_MODELS` restricts which
   `provider:model` refs clients may use (cost control). Empty = all.
5. **IP allowlist** — `SUNDAY_HOSTED_ALLOWLIST` with exact IPs or CIDR ranges
   (e.g. `10.0.0.0/8`). `X-Forwarded-For` is **not** trusted.
6. **Audit logging** — one JSON line per request (timestamp, request id, key
   fingerprint, IP, method, path, model, status, latency, token estimates).
   Message *content* is never logged. Destination: file or `stdout`.
7. **Upstream timeouts** — provider calls abort after
   `SUNDAY_HOSTED_UPSTREAM_TIMEOUT_MS` (default 120s); client disconnect
   aborts the upstream call.

## Configuration

All via environment (`SUNDAY_HOSTED_*`); API keys can also come from a JSON
file (`SUNDAY_HOSTED_CONFIG`, `{"keys":[{"id":"alice","secret":"…"}]}`).

| Variable | Default | Description |
|---|---|---|
| `SUNDAY_HOSTED_KEYS` | *(required)* | Comma-separated `id:secret` API keys |
| `SUNDAY_HOSTED_CONFIG` | — | JSON config file path (for keys) |
| `SUNDAY_HOSTED_PORT` | `8080` | Listen port (`--port` overrides) |
| `SUNDAY_HOSTED_HOST` | `127.0.0.1` | Bind host (`--host` overrides) |
| `SUNDAY_HOSTED_RPM` | `60` | Requests/min per key |
| `SUNDAY_HOSTED_TPM` | `100000` | Input tokens/min per key |
| `SUNDAY_HOSTED_MAX_BODY_BYTES` | `262144` | Max request body |
| `SUNDAY_HOSTED_MAX_MESSAGES` | `100` | Max messages per request |
| `SUNDAY_HOSTED_MAX_MESSAGE_CHARS` | `32768` | Max chars per message |
| `SUNDAY_HOSTED_MAX_TOKENS` | `4096` | `max_tokens` cap |
| `SUNDAY_HOSTED_MODELS` | — | Model allowlist |
| `SUNDAY_HOSTED_ALLOWLIST` | — | IP/CIDR allowlist |
| `SUNDAY_HOSTED_AUDIT_LOG` | `stdout` | Audit log file or `stdout` |
| `SUNDAY_HOSTED_UPSTREAM_TIMEOUT_MS` | `120000` | Provider call timeout |
| `SUNDAY_SESSION_SECRET` | *(required)* | HS256 secret for Sunday session JWTs (Phase 9.a); generate with `openssl rand -base64 48` |

## Security notes for operators

- Never expose this directly to the internet without TLS in front of it.
- Treat provider keys as the crown jewels: they fund every client request.
  Set `SUNDAY_HOSTED_TPM` / `SUNDAY_HOSTED_MODELS` to bound your spend.
- Rotate gateway API keys by updating `SUNDAY_HOSTED_KEYS` and restarting.
- The gateway deliberately cannot run tools — it is an inference endpoint,
  not an agent endpoint.
