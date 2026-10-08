# Sunday — Monetization & Subscription Integration Plan

### How to add Google-based accounts and Basic / Smart / Pro subscriptions to Sunday without breaking its open-source core or any provider's terms of service

| Field | Value |
|---|---|
| Document | `Sunday-monetization-plan.md` — a companion to `Sunday-architecture-plan.md` (the IDE) and `design.md` (the original chat-app design). This document does not repeat either; it cross-references them and specifies only what is new or different. |
| Cross-reference key | A bare `§X` always means a section **of this document**. A reference into the IDE plan is written **`IDE §X`**; a reference into the original chat-app `design.md` is written **`Chat §BX`** — this avoids collisions, since all three documents number their own sections starting from 1. |
| Version | 1.0 |
| Written | 3 October 2026 |
| Owner | Vivek Bartwal |
| Scope | Business model, identity, entitlements, billing, the managed model gateway, client integration, backend architecture, protocol additions, security, testing, and a phased execution plan (**Phase 9** of the overall project) |
| Audience | The author, and AI coding assistants implementing this against the existing Sunday codebase |

> **How to read this document.** Every section states *what changes* and *where it plugs into the existing plan*. If a mechanism already exists in `Sunday-architecture-plan.md` or `design.md`, this document says so and reuses it rather than re-describing it — the loopback OAuth pattern, the rate-limit scheduler, the quota tables, and the router/Relay engine are all reused, not reinvented.

---

## Contents

1. Executive summary & business model
2. The non-negotiable constraint: provider ToS boundary
3. Plan definitions: Basic, Smart, Pro
4. Identity & authentication (Google Sign-In)
5. The entitlements model
6. Billing integration
7. The Managed Model Gateway
8. Client-side integration changes
9. Backend architecture & data model
10. Protocol additions
11. Security & privacy
12. Testing plan
13. Execution plan — Phase 9
14. Risks & mitigations
15. Decision records (ADRs)
16. Open questions
17. Appendices

---

## 1. Executive summary & business model

Sunday is, and remains, a free, open-source, forkable IDE. This plan adds an **optional, paid layer on top of
it** — not a paywall around it — following the same "open-core" pattern used by GitLab, Supabase, and most
VS Code-fork products that monetize successfully (Cursor, Windsurf):

```
┌──────────────────────────────────────────────────────────────────────┐
│  Sunday — free, open-source, forever                                  │
│  Full IDE · full agentd · full orchestration (IDE §9.9) · BYOK · local │
│  Ollama routes. Nothing in the open-source product is crippled.       │
└──────────────────────────────────────────────────────────────────────┘
                                    +
┌──────────────────────────────────────────────────────────────────────┐
│  Sunday Cloud — optional, paid, requires a Google-authenticated account│
│  Managed access to paid-tier models · higher orchestration limits ·   │
│  priority queueing · browser agent · hosted extras                    │
└──────────────────────────────────────────────────────────────────────┘
```

**One-sentence business model:** sell *convenience and managed infrastructure* (pooled paid-model access,
priority, higher limits), never sell access to something that is free elsewhere — BYOK and local-model routes
stay free and fully functional with no account at all.

**Revenue mechanics in one paragraph:** a user subscribes (Basic is free and needs no payment; Smart and Pro
are paid). Their subscription is tied to a Google-authenticated account. That account carries **entitlements**
(§5) that the client checks before enabling gated features. Paid tiers get access to a **Managed Model
Gateway** (§7) — a small backend service that holds *your* paid provider API keys, meters usage per user, and
is the only thing standing between a subscription fee and a provider bill. Everything else in Sunday (the
editor, the agent loop, orchestration, checkpoints) is identical across tiers; only *routing, limits, and a
few gated capabilities* differ.

---

## 2. The non-negotiable constraint: provider ToS boundary

This is stated first because it is the one mistake that can end the business before it starts.

> **Free-tier provider endpoints (NVIDIA NIM's trial API, OpenRouter's free model variants, and similar) are
> evaluation/prototyping offers. They must never be the thing a paying customer is paying for.** Charging
> money for access that is, underneath, a free trial account you are reselling is a terms-of-service violation
> with real consequences: API key revocation (which breaks the product for every user at once, not just one),
> and potential legal exposure for commercial resale of a service you don't have commercial rights to.

The fix is architectural, not a policy note — it is built into §7:

| Route pool | Who can use it | Who pays the provider |
|---|---|---|
| BYOK (user's own key) | Everyone, every tier, no account needed | The user, directly, under their own agreement with the provider |
| Local (Ollama, etc.) | Everyone, every tier, no account needed | Nobody — runs on the user's machine |
| Free-tier pooled routes (if Sunday still ships any, e.g. for a Basic-tier trial experience) | Basic tier only, rate-limited, clearly labelled as best-effort | You, at provider's free-tier terms — **never charged for** |
| **Managed Gateway, paid routes** | Smart / Pro only | **You**, under a *commercial/paid* agreement with the provider, funded by subscription revenue |

This single table is the design constraint every other section in this document is built to satisfy. See
ADR-19.

---

## 3. Plan definitions: Basic, Smart, Pro

These limits are a **starting proposal**. Treat every number as configuration (§9.2's `plans` table), not a
hard-coded constant — you will tune them once you know real managed-provider costs.

| Capability | **Basic** (free, no card) | **Smart** (paid) | **Pro** (paid) |
|---|---|---|---|
| Account required | Optional (local-only use needs none) | Google Sign-In required | Google Sign-In required |
| BYOK / local routes | ✅ Unlimited | ✅ Unlimited | ✅ Unlimited |
| Managed-model requests | ❌ (or a small best-effort free pool) | e.g. 300/day | e.g. 1,500/day or generous fair-use |
| Orchestration (IDE §9.9) | Single-agent only (`maxFeatureAgents`=1, i.e. disabled) | Up to 2 Feature Agents, sequential only | Up to 4+ Feature Agents, parallel (per ADR-17's sequential-first rollout, parallel ships to Pro first) |
| Codebase index (IDE §11.3) | Small repos (size-capped) | Full | Full, larger cap |
| Autocomplete (IDE §22.1) | Local model only | Local + optional managed fast route | Local + managed route, lower latency tier |
| Browser agent (IDE §18) | ❌ | Limited sessions/day | ✅ Full |
| Rate-limit scheduler priority (IDE §10.6) | Standard | Elevated | Highest |
| Support | Community / GitHub issues | Email | Priority email |

Every row in this table is implemented as one or more **entitlement keys** (§5.2) — the client never hard-codes
"if plan == Pro"; it checks entitlements, which is what makes trials, grandfathering, and future tier changes
possible without a client update.

---

## 4. Identity & authentication (Google Sign-In)

### 4.1 Why an embedded popup does not work

Google blocks OAuth sign-in from embedded user agents — including Electron's `BrowserWindow` — and returns a
`disallowed_useragent` error. This is a platform policy, not a bug to work around; the fix is to never attempt
sign-in inside the app's own window at all, and instead use the flow Google itself documents for native/desktop
apps (RFC 8252: OAuth 2.0 for Native Apps).

### 4.2 The flow: system browser + loopback redirect + PKCE

This reuses the exact mechanism already specified for connector OAuth in Chat §B11.2 and for MCP server
auth in IDE §19.4 ("OAuth flows handled by the extension host — open browser,
loopback/URI-handler redirect"). Here it is applied to the account system itself.

```
 Developer              sunday-agent ext.        Loopback server       System browser         Sunday backend       Google
     │   "Sign in"             │                       │                    │                     │                 │
     ├─────────────────────────►                       │                    │                     │                 │
     │                         │ generate PKCE verifier/challenge, state    │                     │                 │
     │                         │ start local HTTP server on 127.0.0.1:<rnd> │                     │                 │
     │                         ├───────────────────────►                    │                     │                 │
     │                         │ host.openExternal(authUrl) ────────────────►                     │                 │
     │                         │                       │                    ├─────────────────────┼────────────────►
     │                         │                       │                    │   consent screen    │                 │
     │                         │                       │                    │◄────────────────────┼─────────────────┤
     │                         │                       │  redirect to       │     (user already    │                 │
     │                         │                       │  127.0.0.1:<rnd>/  │      logged in,      │                 │
     │                         │                       │  callback?code=.. │◄─────────────────────┼── code ─────────┤
     │                         │                       │◄───────────────────┤                     │                 │
     │                         │◄── code, state ───────┤                    │                     │                 │
     │                         │ verify state; show "You can close this tab, return to Sunday"     │                 │
     │                         ├── POST /auth/google/callback {code, verifier} ────────────────────►                 │
     │                         │                       │                    │                     ├── exchange ────►│
     │                         │                       │                    │                     │◄── tokens ──────┤
     │                         │◄── Sunday session token + entitlements ─────────────────────────────┤                 │
     │ ◄── signed in ──────────┤                       │                    │                     │                 │
```

| Step | Detail |
|---|---|
| PKCE | `sunday-agent` generates a `code_verifier` and `code_challenge` (S256) per attempt — never a client secret embedded in the app, per RFC 8252 |
| Loopback server | A short-lived Node HTTP server bound to `127.0.0.1` on an ephemeral port, started just before the browser opens and torn down immediately after the single callback request it expects |
| Browser launch | `host.openExternal(url)` — the same extension-host capability already used to open docs/links elsewhere in the IDE |
| Redirect URI | `http://127.0.0.1:<port>/callback`, registered as a redirect URI pattern in the Google Cloud OAuth client (Desktop app type) |
| Code exchange | Happens **server-side** (Sunday backend), not in the client — the backend holds the OAuth client secret, exchanges the code for Google tokens, verifies the user's identity, and issues Sunday's own session token back to the client |
| Session token storage | Stored via the extension's `SecretStorage` (OS keychain) — identical mechanism to how provider BYOK keys are already stored (IDE §9... / provider key storage), just a different secret name (`aurora_session_token`) |
| Scopes requested | `openid email profile` only — no Drive, Gmail, or Calendar scope; Sunday's account system only needs identity, not access to the user's Google data |

### 4.3 Minimal account data model

```json
{
  "user_id": "u_01HXYZ...",
  "google_sub": "1098765432...",
  "email": "vivek@example.com",
  "display_name": "Vivek Bartwal",
  "avatar_url": "https://lh3.googleusercontent.com/...",
  "plan": "smart",
  "created_at": "2026-10-03T10:00:00Z"
}
```

Deliberately minimal: Sunday does not need a password system (Google is the only sign-in method for v1 — see
Open Question #2), does not need a profile beyond what the consent screen already returns, and stores no
Google access/refresh token beyond the single use of exchanging the authorization code (the account system
needs *identity*, not ongoing API access to the user's Google account).

### 4.4 Session handling

- Sunday's own session token is a short-lived JWT (e.g. 1 hour) plus a longer-lived refresh token, mirroring
  the session model in Chat §B2, adapted from cookie-based web sessions to a token pair suitable for a
  desktop app talking to a backend over plain HTTPS requests.
- `sundayd` attaches the session token as a bearer token on every request to the Managed Gateway (§7) and the
  Entitlements endpoint (§5).
- On refresh failure (revoked session, logged out elsewhere), the client falls back to **signed-out state**,
  which per §8.4's local-first guarantee still leaves BYOK and local routes fully working.
- Sign-out revokes the refresh token server-side and clears the stored session token from `SecretStorage`.
## 5. The entitlements model

### 5.1 Entitlement vs. plan

A **plan** (Basic/Smart/Pro) is what the user bought. An **entitlement** is a specific, checkable permission
or limit derived from that plan. The client never asks "is this user on Pro?" — it asks "does this user have
`orchestration.maxFeatureAgents >= 4`?". This indirection is what lets you run a trial, grandfather an old
plan, or change tier boundaries later without touching client code.

### 5.2 Entitlements schema

```json
{
  "user_id": "u_01HXYZ...",
  "plan": "smart",
  "status": "active",
  "renews_at": "2026-11-03T00:00:00Z",
  "entitlements": {
    "managed_models.enabled": true,
    "managed_models.daily_requests": 300,
    "orchestration.max_feature_agents": 2,
    "orchestration.parallel": false,
    "browser_agent.enabled": true,
    "browser_agent.daily_sessions": 5,
    "codebase_index.max_repo_mb": 500,
    "autocomplete.managed_route": true,
    "scheduler.priority_class": "elevated",
    "support.tier": "email"
  },
  "cached_at": "2026-10-03T10:00:00Z",
  "valid_until": "2026-10-03T11:00:00Z"
}
```

### 5.3 How entitlements gate existing capabilities

| Entitlement key | Checked by | Behaviour when absent/exceeded |
|---|---|---|
| `managed_models.enabled` / `.daily_requests` | Model router (IDE §10.4) before selecting a `managed` route | Managed routes excluded from candidate list; BYOK/local still considered — graceful degrade, not an error |
| `orchestration.max_feature_agents` | Orchestrator decomposition procedure (IDE §9.9.3) | Decomposition is capped at the entitled count; if the goal needs more, the Plan artifact shows "This would benefit from N agents; your plan allows M — upgrade or reduce scope" |
| `orchestration.parallel` | Worktree manager (IDE §9.9.6 / IDE §16.2) | Feature Agents run sequentially even if `owns_paths` don't overlap |
| `browser_agent.enabled` / `.daily_sessions` | `browserd` activation (IDE §18.2) | Browser tool unavailable; agent is told to skip UI verification and say so |
| `codebase_index.max_repo_mb` | Indexer (IDE §11.3) | Indexing stops at the cap with a clear status message, not a silent partial index |
| `scheduler.priority_class` | Rate-limit scheduler (IDE §10.6) | Determines P0–P3 weighting for this user's requests against the shared managed pool |

### 5.4 Fetching, caching, and offline behaviour

- On sign-in and on each app launch, `sundayd` calls `GET /me/entitlements` and caches the result locally
  (`~/.aurora/account/entitlements.json`) with a short `valid_until`.
- While the cache is fresh, every gating check above is a **local, instant** lookup — no network round trip
  on the hot path of routing a model request.
- If the backend is unreachable when the cache expires, the client **keeps using the last known entitlements
  for a grace window** (e.g. 24–72 hours) rather than silently downgrading a paying user to Basic because of a
  network blip, then falls back to Basic-equivalent (BYOK/local only) if the grace window lapses.
- A webhook-driven push (`event.entitlements.updated`, §10) invalidates the cache immediately on a plan
  change, so an upgrade takes effect without waiting for the next poll.

---

## 6. Billing integration

### 6.1 Payment processor: Merchant of Record first

| Option | Business registration needed? | Tax/compliance handling | Fit for a solo student founder |
|---|---|---|---|
| Razorpay | Yes — current account, GST | You handle GST/compliance yourself | Not yet — blocked until a registered entity exists |
| Stripe | Effectively yes for a new India individual account in the current environment (**VERIFY** at integration time, this changes) | You handle tax yourself | Not yet, for the same reason |
| **Lemon Squeezy / Paddle** (Merchant of Record) | **No** — they are the legal seller; you are their "supplier" | They collect and remit VAT/GST/sales tax in every jurisdiction automatically | ✅ **Recommended starting point** — can onboard as an individual |

**Decision:** start with a Merchant-of-Record processor (Lemon Squeezy or Paddle — compare their current fee
structure and payout countries at integration time, both fit this use case). Plan a later migration to a
direct processor (Razorpay/Stripe) once there is a registered business entity and revenue that justifies the
lower fee percentage — the entitlements/webhook architecture below does not need to change for that migration,
only the processor-specific webhook payloads do.

### 6.2 Checkout flow

```
Settings > Plan & Billing (§8.2)
    │  "Upgrade to Smart"
    ▼
sundayd asks backend for a checkout session  ──►  POST /billing/checkout {plan: "smart"}
    │                                                   backend creates a hosted checkout
    │                                                   session with the MoR processor,
    │  ◄── checkout_url ───────────────────────────────  tagged with this user_id
    ▼
host.openExternal(checkout_url)   — same pattern as §4.2's sign-in, system browser, not embedded
    │
    ▼
User pays on the processor's hosted page (card details never touch Sunday's own servers — §11.1)
    │
    ▼
Processor sends a webhook to the Sunday backend: subscription.created
    │
    ▼
Backend updates `subscriptions` + `entitlements` tables, pushes event.entitlements.updated
    │
    ▼
Client's cached entitlements refresh; "Smart" features unlock without restarting the app
```

### 6.3 Webhook handling

| Event | Backend action |
|---|---|
| `subscription.created` | Create/activate the `subscriptions` row; compute and write entitlements for the purchased plan; push `event.entitlements.updated` |
| `subscription.updated` (upgrade/downgrade) | Recompute entitlements; MoR handles proration math — the backend just reacts to the new plan ID in the payload |
| `subscription.cancelled` | Mark `status = cancelling`; entitlements stay at current plan until `renews_at`, then drop to Basic (no hard cutoff mid-period) |
| `payment.failed` | Mark `status = past_due`; start a short grace period (e.g. 3–7 days) before downgrading, matching normal SaaS dunning practice; notify the user by email |
| `subscription.resumed` | Clear `past_due`/`cancelling`, restore entitlements |

**Idempotency:** every webhook carries a processor-issued event ID; the backend stores processed event IDs and
discards duplicates, because MoR processors retry webhooks on any non-2xx response — a handler that isn't
idempotent will double-process a retried event.

**Verification:** every webhook's signature is verified against the processor's signing secret before any
database write; unsigned or badly signed requests are rejected with no further processing.

### 6.4 Cancellation, refunds, and the customer portal

Both Lemon Squeezy and Paddle provide a **hosted customer portal** (manage payment method, view invoices,
cancel) — reuse it rather than building billing UI yourself. `Settings > Plan & Billing` has a "Manage
subscription" button that opens this portal the same way checkout opens (`host.openExternal`, §6.2). Refunds
are issued from the processor's dashboard and arrive at your backend as another `subscription.*` webhook; no
separate refund code path is needed in v1.
## 7. The Managed Model Gateway

This is the only genuinely new infrastructure this plan requires — everything else is accounts/billing
plumbing. It is a **server-side deployment of the same routing concept already designed** in
IDE §10, pointed at *your* paid provider accounts instead of the user's own.

### 7.1 Why a server, not a client-side key

BYOK and local routes call providers **directly from the user's machine** — that is correct and stays
unchanged (ADR-04 in the IDE plan: never ship a shared key inside the distributed app). Paid managed access
cannot work that way: a key embedded in or sent to every installed copy of Sunday is a key that will leak
within days. The gateway exists specifically to keep your paid provider keys server-side, authenticate every
request to a real paying user, and meter usage — the same reason every "AI product with a free model tier and
a paid one" (Cursor, Windsurf, Copilot) runs a backend instead of distributing provider keys.

### 7.2 Architecture

```
          sundayd (client)                         Sunday backend                        Providers
     ┌─────────────────────────┐    HTTPS, Bearer    ┌───────────────────────┐
     │ Router picks a route. If │   session token     │ Managed Gateway        │
     │ route.provider ==        │────────────────────►│  1. verify session     │
     │ "managed":               │                     │  2. check entitlements │     paid accounts:
     │   POST /v1/managed/chat  │                     │     (daily cap, plan)  │   ┌─────────────────┐
     │        /completions      │                     │  3. pick a paid route  │──►│ NVIDIA (paid)    │
     │   (OpenAI-compatible     │                     │     — SAME router/     │   ├─────────────────┤
     │    request shape)        │                     │     Relay logic,       │──►│ OpenRouter       │
     │                          │◄────────────────────│     run server-side    │   │ (paid credits)   │
     │ Relay handles gateway-   │   streamed response  │  4. stream tokens back │   ├─────────────────┤
     │ level failures exactly   │                      │  5. meter usage        │──►│ Together/Groq/…  │
     │ like any other route     │                      │     (§7.4)             │   └─────────────────┘
     │ failure                 │                      └───────────────────────┘
     └─────────────────────────┘
```

"Router" and "Relay" in this diagram are the exact mechanisms specified in IDE §10 and IDE §10.4, deployed a
second time — server-side, against the paid route pool, instead of client-side against BYOK/local/free routes.

Because the request/response shape at `/v1/managed/chat/completions` is OpenAI-compatible — the same contract
every other adapter in the registry already speaks (IDE §10.3) — the client-side
router treats "managed" as just one more provider type. No special-case logic is needed in the agent loop,
the context engine, or the Relay/fallback mechanism; a managed-route failure falls back to the next candidate
route exactly as a NIM or OpenRouter failure would.

### 7.3 Registry addition

```yaml
providers:
  aurora_managed:
    type: openai_compatible
    base_url: https://api.aurora.app/v1/managed
    auth: { type: bearer, source: aurora_session_token }   # not a provider API key —
                                                            # the user's own Sunday session
    default_limits: { rpm: "per-entitlement" }             # enforced server-side (§7.5),
                                                            # client-side limit is advisory only

models:
  - id: sunday-smart-default
    display_name: "Sunday Smart (managed)"
    routes: [ { provider: aurora_managed, provider_model_id: "smart-tier", context: "<server-selected>" } ]
    requires_entitlement: "managed_models.enabled"
    tier: managed
  - id: sunday-pro-default
    display_name: "Sunday Pro (managed)"
    routes: [ { provider: aurora_managed, provider_model_id: "pro-tier", context: "<server-selected>" } ]
    requires_entitlement: "managed_models.enabled"
    min_plan: pro
```

The server, not the client, decides *which actual underlying model* serves `smart-tier`/`pro-tier` at any
given moment — this is exactly the router/Relay logic of IDE §10 run server-side, so you can swap or rebalance
underlying paid providers without ever shipping a client update. The client only needs to know the request
went to "a managed route" and how to render its Relay marker if the gateway itself fails over internally.

### 7.4 Metering

Every request logged by the gateway:

```json
{
  "user_id": "u_01HXYZ...",
  "route": "sunday-smart-default",
  "tokens_in": 1820,
  "tokens_out": 640,
  "cost_estimate_usd": 0.0043,
  "latency_ms": 2100,
  "status": "ok",
  "at": "2026-10-03T10:14:02Z"
}
```

Aggregated daily (`usage_daily`, §9.2) to (a) enforce `managed_models.daily_requests`, (b) power the usage
dashboard (§8.2, reusing the concept from Chat §B18.4), and (c) give you, the operator, real per-user
cost visibility — essential for pricing the plans correctly once real traffic exists.

### 7.5 Cost controls

A subscription fee is a *flat* fee; provider cost is *variable*. Without controls, one heavy user on a flat
Pro plan can cost more than their subscription covers. Mitigations, layered:

| Control | Detail |
|---|---|
| Daily request caps per plan (§3) | The first and simplest lever |
| Per-user **soft cost budget** | If a user's rolling cost materially exceeds their plan's expected cost, drop their scheduler priority (IDE §10.6) before hard-blocking them |
| Per-user **hard cost ceiling** | An absolute stop-loss per billing period, set well above normal usage, that pages you (the operator) rather than silently absorbing unbounded cost |
| Route selection favours cheaper capable models first | The server-side router's scoring (IDE §10.4's `score(route)`) weights cost more heavily here than the client-side version does, since here *you* are paying |
| Abuse detection | Rate-limit account creation and flag unusual patterns (many accounts, same payment method or device fingerprint) — start simple (manual review) and automate only once volume justifies it |

---

## 8. Client-side integration changes

### 8.1 New settings (`aurora.account.*`, `aurora.billing.*`)

Extends IDE §21.1:

| Key | Type | Default | Description |
|---|---|---|---|
| `aurora.account.signedIn` | bool (read-only, derived) | false | Reflects current session state |
| `aurora.account.email` | string (read-only, derived) | — | Display only |
| `aurora.billing.plan` | enum (read-only, derived) | `basic` | Current plan, from cached entitlements |
| `aurora.managedModels.preferOverByok` | enum | `byokFirst` | `byokFirst` / `managedFirst` / `managedOnly` — lets a paying user still prefer their own key when they have one |
| `aurora.managedModels.showUpgradePrompts` | bool | true | Whether gated-feature touchpoints show an upgrade CTA or just silently omit the feature |

### 8.2 UI: Settings → Plan & Billing

```
┌─────────────────────────────────────────────────────────────┐
│ Plan & Billing                                                │
│                                                                │
│  ○ Not signed in          [ Sign in with Google ]             │
│                                                                │
│  (after sign-in)                                              │
│  ● vivek@example.com                          [ Sign out ]    │
│                                                                │
│  Current plan:  Smart                                         │
│  Renews:        3 November 2026                               │
│  Managed requests today:  112 / 300   ▓▓▓▓▓▓░░░░░░░░░░        │
│                                                                │
│  [ Manage subscription ]   [ Upgrade to Pro ]                 │
│                                                                │
│  Usage this month ▸          (reuses Chat §B18.4 pattern)    │
└─────────────────────────────────────────────────────────────┘
```

- "Sign in with Google" triggers §4.2's loopback flow.
- "Manage subscription" opens the MoR hosted customer portal (§6.4).
- "Upgrade to Pro" opens checkout (§6.2) for users already on Smart.
- The usage meter reads from cached entitlements + a lightweight `/me/usage/today` call, not from re-deriving
  it client-side — the server's count is authoritative since it is also the enforcement point.

### 8.3 Gated-feature touchpoints

Rather than one central paywall, gating shows up exactly where a feature already lives, each with a small,
consistent affordance:

| Where | Behaviour at the entitlement boundary |
|---|---|
| Model/provider selection UI (IDE §20.7) | Managed models are listed but show a lock icon + plan badge if `requires_entitlement` isn't met; clicking opens an upgrade prompt instead of calling the model |
| Orchestrator's Plan artifact (IDE §9.9.13) | If a decomposition wants more Feature Agents than `orchestration.max_feature_agents` allows, the plan is still shown, capped, with a one-line note on why |
| Browser agent toggle (IDE §18) | Disabled with a tooltip explaining the entitlement, rather than hidden — discoverability matters more than hiding the upsell |

### 8.4 Local-first guarantee (explicit design rule)

> **No part of Sunday's core editing, agent loop, or orchestration logic may check network or account state
> before running on a BYOK or local route.** Signed-out, offline, or backend-down are all the same case from
> the agent loop's point of view: managed routes are simply absent from the candidate list, and everything
> else works exactly as it does for a user who has never created an account. This is enforced as ADR-20, and
> is the reason the open-source product in §1's diagram is never "crippled."

### 8.5 Usage dashboard

Reuses the design and fields already specified in Chat §B18.4 (messages/tokens by model, by provider,
storage used, export) almost unchanged — the only addition is a "via managed gateway" vs. "via your own key"
split per row, so a user can see exactly which of their usage is metered against their plan and which is free
BYOK traffic.
## 9. Backend architecture & data model

### 9.1 Services

A small set of services, deployable as one process to start (split out only once load demands it) — this does
not need to be more elaborate than the budget-conscious infrastructure already proposed in Chat §B27.2.

| Service | Responsibility |
|---|---|
| **Accounts** | Google OAuth code exchange (§4.2), session issuance/refresh/revocation |
| **Billing** | Checkout session creation, webhook ingestion and verification (§6.3) |
| **Entitlements** | Plan → entitlements mapping (§5.2), serves `/me/entitlements`, publishes `event.entitlements.updated` |
| **Managed Gateway** | The server-side router/adapter/Relay from §7, metering, cost controls |
| **Usage** | Aggregates metering events into daily/monthly rollups for dashboards and enforcement |

### 9.2 Data model

```sql
users(id, google_sub unique, email citext unique, display_name, avatar_url,
      created_at, deleted_at)

sessions(id, user_id, refresh_token_hash, issued_at, expires_at, revoked_at,
         device_label)

plans(id, name, price_cents, currency, interval, entitlements_template jsonb)
      -- e.g. ('basic', 0, ...), ('smart', 49900, 'inr', 'month', {...}),
      --      ('pro',   149900, 'inr', 'month', {...})

subscriptions(id, user_id, plan_id, processor, processor_subscription_id,
              status,            -- active | past_due | cancelling | cancelled
              renews_at, cancel_at, created_at, updated_at)

entitlements(user_id pk, plan_id, entitlements jsonb, computed_at)
             -- the materialised, served-to-client view; recomputed whenever
             -- subscriptions changes, from plans.entitlements_template

billing_events(id, processor, processor_event_id unique, type, payload jsonb,
                processed_at)   -- idempotency ledger for §6.3

managed_requests(id, user_id, route, tokens_in, tokens_out, cost_estimate_usd,
                  latency_ms, status, created_at)   -- §7.4, partitioned by month at scale

usage_daily(user_id, day, managed_requests, managed_tokens_in, managed_tokens_out,
            browser_agent_sessions, orchestration_runs)
```

`entitlements` is deliberately a **materialised, denormalised** table — the client's hot-path read
(`GET /me/entitlements`) must be a single cheap lookup, not a join across `subscriptions` + `plans` on every
request from every installed copy of Sunday.

### 9.3 API surface

| Endpoint | Purpose |
|---|---|
| `POST /auth/google/callback` | Exchange authorization code (§4.2) for an Sunday session |
| `POST /auth/refresh` | Rotate an expiring session token |
| `POST /auth/logout` | Revoke the current session |
| `GET /me` | Basic profile |
| `GET /me/entitlements` | Current entitlements (§5.2) — the client's primary read |
| `GET /me/usage/today` | Backing data for §8.2's usage meter |
| `GET /me/usage` | Full usage dashboard data (§8.5) |
| `POST /billing/checkout` | Create a hosted checkout session for a given plan (§6.2) |
| `POST /billing/portal` | Create a hosted customer-portal session (§6.4) |
| `POST /billing/webhook` | Processor webhook receiver (§6.3), signature-verified |
| `POST /v1/managed/chat/completions` | The Managed Gateway's OpenAI-compatible endpoint (§7.2–§7.3) |

### 9.4 Infrastructure notes

Reuses the budget-friendly stack already proposed in Chat §B27.2 (small API host, managed Postgres,
Redis for session/rate-limit state) with two additions specific to handling money: **every webhook handler is
idempotent and logs to `billing_events` before acting** (§6.3), and **structured audit logging on every
entitlement change** (who/what/when caused a plan to change) — because billing disputes are a "show me exactly
what happened and when" problem, not just an engineering one.

---

## 10. Protocol additions

Extends the JSON-RPC catalogue in IDE §23.2, using the same transport and framing.

| Method / event | Direction | Purpose |
|---|---|---|
| `account.signIn` | client → sundayd | Kick off §4.2's loopback flow |
| `account.signOut` | client → sundayd | Revoke session, clear cached entitlements |
| `account.status` | client → sundayd | Current sign-in state, for UI (§8.2) |
| `billing.openCheckout` | client → sundayd | Open hosted checkout for a plan (§6.2) |
| `billing.openPortal` | client → sundayd | Open the hosted customer portal (§6.4) |
| `event.account.signedIn` / `signedOut` | sundayd → client | Drives the Plan & Billing UI's state |
| `event.entitlements.updated` | sundayd → client | Pushed after any webhook-driven plan change (§5.4, §6.3); invalidates the local entitlements cache immediately |

---

## 11. Security & privacy

### 11.1 PCI scope avoidance

Sunday's own backend **never receives, sees, or stores a card number**. Checkout and the customer portal are
both hosted pages served by the Merchant-of-Record processor (§6.1); the backend only ever receives a
`processor_subscription_id` and webhook events. This keeps Sunday entirely outside PCI-DSS scope — a
deliberate, not incidental, property of choosing a MoR processor at this stage.

### 11.2 Token storage

The Sunday session token (§4.4) is stored exactly like a BYOK provider key already is — in the OS keychain via
the extension's `SecretStorage`, never in `settings.json`, never logged. The same redaction rules that apply
to provider keys throughout the IDE plan (e.g. IDE §15, IDE §20) apply here without modification.

### 11.3 Data minimisation on the Google account

Only `openid email profile` scopes are requested (§4.2) — no Drive, Gmail, or Calendar access, because the
account system's only job is identity. No Google access/refresh token is retained past the single code
exchange; Sunday issues and manages its own session tokens from that point on.

### 11.4 Compliance posture

A Privacy Policy and Terms of Service become mandatory once real payments exist (most payment processors
require linking both before enabling checkout). At minimum they must disclose: what Google profile data is
stored, how usage/billing data is retained, and the user's rights to export/delete it — consistent with the
data-lifecycle principles already laid out in Chat §B21, extended to cover the new `users`,
`subscriptions`, and `managed_requests` tables. India's DPDP Act and (for any EU users) GDPR both expect the
same basics: a lawful basis for processing, a deletion path, and no silent repurposing of billing data.

### 11.5 Abuse and fraud posture (v1 — lightweight)

Start simple rather than over-engineering this before there is real traffic: rate-limit account creation per
IP, flag (not auto-block) multiple accounts sharing a payment method, and rely on the Merchant of Record's own
fraud/chargeback tooling for payment-level fraud — building custom fraud detection before you have real abuse
patterns to learn from is effort spent on the wrong problem at this stage.

---

## 12. Testing plan

| Area | Approach |
|---|---|
| OAuth loopback flow | Automated test using a mock Google authorization endpoint pointed at the real loopback server code; manual pass against real Google OAuth before each release |
| Webhook handling | Replay recorded sample payloads from the processor's test/sandbox mode; explicitly test duplicate-event idempotency (§6.3) and bad-signature rejection |
| Entitlement gating | Unit tests per gated capability (§5.3) asserting the exact degrade behaviour (excluded from candidates, capped, disabled-with-tooltip) — never a hard crash |
| Local-first guarantee | A dedicated test suite that disables network entirely and asserts every BYOK/local code path is unaffected (ADR-20) |
| Managed Gateway | Contract tests against a fake upstream provider, mirroring the fake-provider-server pattern already specified for the client-side router in IDE §24.1 |
| Cost controls | Inject synthetic high-cost usage in a staging environment and verify the soft/hard budget controls (§7.5) trigger correctly before any real spend is at risk |
## 13. Execution plan — Phase 9

*Sits after Phase 8 ("After beta") in IDE §28, or earlier in parallel once the core
product is stable enough to support paying users — see Open Question #1.*

**9.a — Accounts foundation (no billing yet).**
1. Google Cloud OAuth client (Desktop app type); loopback redirect URI pattern registered.
2. Backend `Accounts` service: code exchange, session issuance/refresh/revocation, `users`/`sessions` tables.
3. `sundayd`: `account.signIn/signOut/status`, loopback server, `SecretStorage` integration (§4).
4. Settings → Plan & Billing UI shell with sign-in/sign-out only (no plans yet).

**Exit (M9.a):** a developer can sign in with Google from the app, see their email in Settings, sign out, and
sign back in; session survives an app restart; works identically whether or not the backend is reachable for
every *other* Sunday feature (local-first guarantee, ADR-20).

> **9.a implementation note (2026-10-08, hosted-gateway).** The Accounts
> service is implemented in `packages/hosted-gateway/src/accounts.ts`:
> Google token → session JWT (1h, HS256) + rotating refresh token (30d),
> `data/users.json` + `data/sessions.json` JSON files (0600 in a 0700 dir,
> atomic tmp+rename writes), and `GET /me/entitlements` returning the Basic
> plan. JSON-file storage is a deliberate no-billing-phase stopgap.
> **Billing (9.c) REQUIRES Postgres** — flat files are not safe under
> concurrent writers (lost updates on refresh-token rotation, no
> idempotency ledger for webhook events) and must be replaced before any
> money flows. Render's free tier ships no managed Postgres, so the
> database move is scheduled with the 9.c billing work.

**9.b — Entitlements and gating (still no real payments).**
5. `plans`/`entitlements` tables, seeded with Basic/Smart/Pro templates (§3, §9.2).
6. `GET /me/entitlements`; client-side caching and the grace-window fallback (§5.4).
7. Wire every gated touchpoint from §8.3 to real entitlement checks, defaulting every account to Basic.
8. A manual/admin-only way to flip a test account to Smart/Pro, to develop and test gating before billing exists.

**Exit (M9.b):** flipping a test account's plan in the admin view instantly changes what the client allows,
with no app restart; every gated feature degrades gracefully (§8.3) rather than erroring when absent.

**9.c — Billing integration.**
9. Merchant-of-Record account setup (Lemon Squeezy or Paddle — finalise choice per Open Question #4), products
   configured for Smart and Pro.
10. `POST /billing/checkout`, `POST /billing/portal`, `host.openExternal` wiring in `sundayd` (§6.2, §6.4).
11. `POST /billing/webhook` with signature verification and the `billing_events` idempotency ledger (§6.3).
12. Dunning/grace-period handling for `payment.failed` (§6.3).

**Exit (M9.c):** a real low-value test transaction (processor's sandbox/test mode) flows end to end — checkout
→ webhook → entitlements updated → client unlocks Smart features — with no manual intervention; a cancelled
subscription correctly rides out the current period before downgrading.

**9.d — Managed Model Gateway.**
13. Paid accounts opened with 1–2 providers (start narrow; expand once usage data justifies more routes).
14. Server-side router/adapter/Relay (§7.2–§7.3), reusing the client-side router's design, not its code (the
    server has different trust and cost constraints — see §7.5).
15. Metering (`managed_requests`, `usage_daily`) and the soft/hard cost-control triggers (§7.5).
16. Client-side `managed` provider type wired into the model picker, respecting `aurora.managedModels.*`
    settings (§8.1).

**Exit (M9.d):** a Smart-plan user's managed-model requests are served, metered accurately against a sandbox
cost ledger, capped at their daily limit with a clear in-app message, and fail over to BYOK/local on a
simulated gateway outage exactly like any other Relay event.

**9.e — Polish and launch.**
17. Usage dashboard (§8.5) wired to real `/me/usage` data.
18. Terms of Service, Privacy Policy, refund policy published and linked from checkout and Settings.
19. Load-test the webhook endpoint and the Managed Gateway's hot path independently of each other.
20. Soft launch to a small group (e.g. your existing Sunday users/waitlist) before any public pricing push.

**Exit (M9 / launch-ready):** a new user can discover Sunday, use it entirely free (BYOK/local), decide to
upgrade, pay, and get a working managed experience — and you can see, in the usage dashboard, that the
subscription revenue for that user covers their metered provider cost.

---

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Cost-before-revenue**: paid provider accounts bill you regardless of subscriber count | Delay 9.d until there is real demand signal (waitlist, explicit requests); start with the narrowest possible paid-provider footprint; hard cost ceilings (§7.5) from day one |
| Reselling a free-tier provider account to paying users | Structurally prevented by §2's routing table and ADR-19 — paid routes only ever use provider accounts under a commercial agreement |
| Google OAuth "unverified app" warning blocking real users | Submit the OAuth consent screen for Google's verification well before public launch (requires a privacy policy URL and a short review) — treat this as a launch-blocking task, not an afterthought |
| Webhook replay/duplication causing double-granted entitlements | Idempotency ledger (`billing_events`, §6.3) is mandatory, tested explicitly (§12) |
| A paying user's managed feature breaks when the backend is briefly down | Local-first guarantee (§8.4, ADR-20) plus the entitlements grace window (§5.4) — degrade, never hard-fail |
| Chargebacks / disputed payments | Handled by the Merchant of Record's own tooling (§6.1); your backend only needs to react correctly to the resulting webhook, already covered by §6.3 |
| Scope creep: billing UI reinvents what the processor's hosted portal already does | Explicit rule in §6.4 — always deep-link to the hosted portal, never build custom subscription-management UI in v1 |
| A single heavy user's real provider cost exceeds their flat subscription fee | Layered cost controls (§7.5): daily caps → soft priority demotion → hard ceiling with operator alert |

---

## 15. Decision records (ADRs)

| ID | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| ADR-19 | Paid (managed) routes **only ever use provider accounts under a commercial/paid agreement**; free-tier provider accounts are never placed behind a paywall | Resell free-tier access and absorb the ToS risk | Account-ban and legal exposure risk is existential for the whole product, not a cost worth risking (§2) |
| ADR-20 | **Local-first guarantee**: no core editing, agent-loop, or orchestration logic may depend on network or account state to use BYOK/local routes | Require sign-in for full functionality | Preserves the open-source product's integrity (§1) and keeps the free tier genuinely free, not a crippled trial |
| ADR-21 | Identity via **Google Sign-In only** for v1, using the system-browser loopback + PKCE flow (RFC 8252) | Email/password; multiple OAuth providers | Embedded-webview OAuth is blocked by Google outright (§4.1); one well-implemented provider beats three half-implemented ones for v1 |
| ADR-22 | Billing via a **Merchant of Record** (Lemon Squeezy/Paddle) rather than a direct processor | Razorpay/Stripe direct | No business entity required yet; tax/VAT/GST compliance handled by the processor (§6.1) |
| ADR-23 | Entitlements are a **materialised, denormalised table**, recomputed on every subscription change, rather than joined at read time | Join `subscriptions`+`plans` per request | The entitlements read is the hottest path in the whole monetization layer — every model request checks it |
| ADR-24 | The Managed Gateway's server-side router **reuses the design, not the code,** of the client-side router (IDE §10) | Share a single router implementation across client and server | Different trust boundary (server pays real money; must weight cost higher) and different deployment target justify a parallel, not shared, implementation |

---

## 16. Open questions for you

1. Does Phase 9 start right after the IDE's beta (IDE §28 Phase 8), or earlier, in parallel with Phase 6/7, once
   there is a waitlist or explicit paid-tier demand signal worth validating sooner?
2. Google-only sign-in for v1, or do you also want GitHub sign-in from the start (many developer-tool
   audiences expect it, and the loopback-OAuth mechanism in §4.2 is already provider-agnostic)?
3. Final pricing for Smart and Pro — this plan used illustrative numbers (§3); real numbers depend on the
   actual per-request cost once a managed provider is chosen (§9.d step 13).
4. Lemon Squeezy or Paddle specifically — worth a short side-by-side on current fees, supported payout
   countries, and India-specific support before committing (§6.1 flags this as a build-time check).
5. Should Basic include *any* pooled managed-model access (a small free trial taste of "Smart"), or should
   Basic be BYOK/local only with no managed access at all, as modelled in §3's table?
6. Team/organisation plans (multiple seats billed together) — out of scope for this plan; worth a follow-up
   document once individual subscriptions are live and there is demand for it.

---

## 17. Appendices

### A.1 Sample webhook payload (illustrative shape — exact fields differ by processor; **VERIFY** at integration time)

```json
{
  "event_id": "evt_01J...",
  "type": "subscription.created",
  "data": {
    "subscription_id": "sub_01J...",
    "customer_email": "vivek@example.com",
    "plan_id": "smart",
    "status": "active",
    "current_period_end": "2026-11-03T00:00:00Z"
  }
}
```

### A.2 Sample `/me/entitlements` response

See §5.2 — identical shape, served directly from the `entitlements` table of §9.2.

### A.3 Google OAuth consent screen checklist (pre-launch)

- Privacy Policy URL published and linked.
- Application homepage URL published.
- Scopes limited to `openid email profile` (§4.2) — minimises review friction.
- App submitted for Google's verification ahead of public launch (unverified apps show a warning screen and
  may cap daily users) — **VERIFY** current requirements and turnaround time before finalising a launch date.

### A.4 Glossary

| Term | Meaning |
|---|---|
| **Merchant of Record (MoR)** | A payment processor that is the legal seller of the subscription, handling tax/VAT/GST and chargebacks on your behalf |
| **Entitlement** | A specific, checkable permission or limit derived from a user's plan (§5.1) |
| **Managed route** | A model route served through Sunday's own paid provider accounts, metered per user (§7) |
| **Loopback OAuth** | The RFC 8252 pattern of opening the system browser and catching the redirect on a local, ephemeral HTTP server (§4.2) |
| **Local-first guarantee** | The rule that BYOK/local functionality never depends on network or account state (§8.4, ADR-20) |

---

### A.5 Plan templates (Phase 9.b, implemented)

Plan templates live in `packages/hosted-gateway/data/plans.json` (versioned,
`version: 1`). The gateway computes a user's served entitlements from their
plan's template via `computeEntitlements()` in
`packages/hosted-gateway/src/entitlements.ts`. Prices are illustrative —
tune once real managed-provider costs are known.

| Plan | Price (illustrative) | Managed req/day | Max agents | Parallel | Browser agent | Index cap |
|---|---|---|---|---|---|---|
| Basic | ₹0 | 200 | 1 | no | no | 100 MB |
| Smart | ₹499/mo | 300 | 2 | no | 5 sessions/day | 500 MB |
| Pro | ₹1499/mo | 1500 | 4 | yes | 50 sessions/day | 2000 MB |

**Client contract:** `packages/ext-agent/src/entitlements/types.ts`. Client
code checks entitlement keys (`getEntitlements()`), never plan names. Cache:
1h `valid_until`, 72h grace window when the backend is unreachable, then a
Basic-equivalent fallback with managed routes disabled. The gateway
re-checks entitlements server-side on every managed request, so a stale or
tampered client cache can only hide UI — never bypass limits.

**Admin testing:** `POST /admin/users/:id/plan` (gateway, `SUNDAY_ADMIN_KEY`
required) recomputes entitlements from the plan template. For testing gating
before billing exists — not for production use.

*End of `Sunday-monetization-plan.md` v1.0 (Phase 9.b appendix added)*
