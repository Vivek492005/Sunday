# Sunday Payment Architecture — Cashfree (India)

**Version:** 1.0 | **Date:** 2026-10-08 | **Status:** Design (not implemented)

## 1. Design Principles

1. **Never touch money credentials** — All payments happen on Cashfree's hosted pages. Our servers never see UPI PINs, card numbers, or bank details. Zero PCI-DSS scope.
2. **Idempotency everywhere** — Every webhook, every state transition, every charge must be safe to retry. Cashfree retries webhooks on non-2xx; our handlers must not double-process.
3. **Entitlements are derived, never stored as truth** — The subscription record is the source of truth. Entitlements are computed from it. A single `recomputeEntitlements(userId)` function is the only writer.
4. **Graceful degradation** — Payment system downtime must never break the IDE. If Cashfree is unreachable, existing subscriptions continue; only new purchases pause.
5. **Audit everything** — Every billing event is logged immutably. Disputes are resolved by reading the log, not by guessing.
6. **Provider-agnostic core** — Cashfree is the first provider. The architecture must accept Paddle (global) later without rewriting the subscription engine.

---

## 2. System Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐     ┌───────────┐
│  Sunday IDE  │     │   Sunday     │     │  Payment Service │     │ Cashfree  │
│  (ext-agent) │     │   Gateway    │     │  (new module)    │     │  API      │
└──────┬───────┘     └──────┬───────┘     └────────┬─────────┘     └─────┬─────┘
       │                    │                      │                     │
       │  "Upgrade"         │                      │                     │
       │───────────────────►│                      │                     │
       │                    │ POST /billing/       │                     │
       │                    │   checkout           │                     │
       │                    │─────────────►│       │                     │
       │                    │              │ Create order +              │
       │                    │              │ subscription via            │
       │                    │              │ Cashfree API                │
       │                    │              │─────────────────────►│      │
       │                    │              │◄──── payment link ───│      │
       │                    │◄── checkoutUrl ──────│                     │
       │◄── openExternal ───│                      │                     │
       │                    │                      │                     │
       │  User pays on Cashfree hosted page (UPI/Card) + approves AutoPay mandate
       │                    │                      │                     │
       │                    │              │◄── webhook: ────────│      │
       │                    │              │  subscription.activated     │
       │                    │              │  (HMAC verified,            │
       │                    │              │   idempotency checked)      │
       │                    │              │                             │
       │                    │              │ Update subscription ─┐      │
       │                    │              │ Recompute entitlements│     │
       │                    │              │ Generate GST invoice  │     │
       │                    │              │ Log audit event     ─┘      │
       │                    │                      │                     │
       │  ┌── Entitlements refreshed (poll or push) ──┐                 │
       │◄─────────────────────────────────────────────┘                 │
       │  "Pro features unlocked"                                       │
       └────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Details

### 3.1 Cashfree API Client (`billing/cashfree.ts`)

**Responsibilities:**
- Authenticated API calls using `CASHFREE_APP_ID` + `CASHFREE_SECRET_KEY` (server-side only)
- Environment switching: `sandbox` for testing, `production` for live
- Request signing per Cashfree's API spec

**Key operations:**
| Operation | Cashfree API | Purpose |
|---|---|---|
| Create order | `POST /pg/orders` | One-time payment for first subscription charge |
| Create subscription | `POST /pg/subscriptions` | Recurring billing with UPI AutoPay mandate |
| Fetch subscription | `GET /pg/subscriptions/{id}` | Reconciliation, status checks |
| Cancel subscription | `POST /pg/subscriptions/{id}/cancel` | User-initiated cancellation |
| Create refund | `POST /pg/refunds` | Operator-initiated refunds |

**Safety rules:**
- All amounts in paise (integer) to avoid floating-point errors
- Every API call has a timeout (10s) and retry with exponential backoff (max 3)
- All requests/responses logged (without secrets) for debugging

### 3.2 Webhook Processor (`billing/webhooks.ts`)

**Cashfree webhook security:**
- Cashfree signs webhooks with HMAC-SHA256 using your secret key
- Signature in `x-webhook-signature` header (verify before parsing body)
- Timestamp in `x-webhook-timestamp` header (reject if >5 min old — replay protection)

**Processing pipeline (strict order):**
```
1. Receive raw body (do NOT JSON-parse yet)
2. Verify HMAC signature → 401 if invalid (log attempt)
3. Verify timestamp freshness → 401 if stale
4. Parse JSON body
5. Check event_id in billing_events table → 200 OK if duplicate (idempotent)
6. Insert event_id into billing_events (with row lock to prevent race)
7. Route to event handler based on event type
8. Handler updates subscription state
9. Handler calls recomputeEntitlements(userId)
10. Handler generates side effects (invoice, notification)
11. Return 200 OK
```

**Event types handled:**
| Cashfree Event | Our Action |
|---|---|
| `SUBSCRIPTION_ACTIVATED` | status=active, set period dates, recompute entitlements, generate invoice |
| `SUBSCRIPTION_CHARGED` | Record payment, extend period, generate invoice for renewal |
| `SUBSCRIPTION_CANCELLED` | status=cancelling, keep entitlements until period end |
| `SUBSCRIPTION_EXPIRED` | status=expired, downgrade to Free, recompute entitlements |
| `PAYMENT_FAILED` | status=past_due, start dunning (see §6), notify user |
| `PAYMENT_SUCCESS` | Record payment, clear past_due if applicable |
| `REFUND_PROCESSED` | Log refund, no entitlement change (already handled by cancellation) |

### 3.3 Subscription State Machine

```
                    ┌─────────────┐
                    │    FREE     │◄─────────────────────┐
                    │ (no record) │                      │
                    └──────┬──────┘                      │
                           │ checkout + payment          │ period end /
                           │ success                   │ manual downgrade
                           ▼                           │
                    ┌─────────────┐    cancel      ┌─────────────┐
                    │   ACTIVE    │───────────────►│ CANCELLING  │
                    └──────┬──────┘  (keeps access │ (access until│
                           │       until period    │  period end) │
                           │       end)            └──────┬──────┘
                    payment│failed                       │ period end
                           ▼                             ▼
                    ┌─────────────┐                ┌─────────────┐
                    │  PAST_DUE   │                │  EXPIRED    │
                    │ (grace: 7d) │                │ → FREE      │
                    └──────┬──────┘                └─────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         payment        grace       grace
         success       extended    expired
              │            │            │
              ▼            ▼            ▼
           ACTIVE      PAST_DUE      EXPIRED
                       (extended)   → FREE
```

**Rules:**
- Only `ACTIVE` and `CANCELLING` grant paid entitlements
- `PAST_DUE` keeps entitlements during grace (7 days) — don't punish for bank issues
- `EXPIRED` immediately recomputes to Free entitlements
- All transitions are logged with `from → to`, `reason`, `at`, `triggered_by`

### 3.4 Entitlement Computation (`billing/entitlements.ts`)

**Single writer principle:**
```typescript
// THE ONLY function that writes entitlements. Called by:
// - Webhook handlers (after subscription change)
// - Dunning sweep (after grace expiry)
// - Admin override (manual plan change)
// - New sign-in (initial computation)
async function recomputeEntitlements(userId: string): Promise<void>
```

**Plan → Entitlements mapping:**
```typescript
const PLANS = {
  free:  { price: 0,   managedDaily: 200,  agents: 1, agentsParallel: false,
           indexMB: 100,  browserDaily: 0,  support: 'community' },
  basic: { price: 149, managedDaily: 500,  agents: 2, agentsParallel: false,
           indexMB: 500,  browserDaily: 5,  support: 'email' },
  smart: { price: 349, managedDaily: 1200, agents: 3, agentsParallel: false,
           indexMB: 2000, browserDaily: 15, support: 'email' },
  pro:   { price: 799, managedDaily: 3000, agents: 4, agentsParallel: true,
           indexMB: 5000, browserDaily: -1, support: 'priority' },  // -1 = unlimited
};
```

### 3.5 UPI AutoPay Specifics

**How it works:**
1. First payment: user pays via UPI + approves AutoPay mandate (max ₹15,000/transaction)
2. Cashfree creates a subscription with the mandate reference
3. Monthly: Cashfree auto-debits via UPI (user gets pre-debit notification per RBI rules)
4. User can revoke mandate from their UPI app → we get `SUBSCRIPTION_CANCELLED` webhook

**RBI compliance notes:**
- Pre-debit notification 24h before charge (handled by Cashfree/UPI ecosystem)
- User can set mandate limit; our plans (max ₹799) are well within limits
- Additional Factor Authentication (AFA) required for amounts >₹15,000 (not applicable to us)

**Failure modes specific to UPI AutoPay:**
| Scenario | Handling |
|---|---|
| User revokes mandate in UPI app | `SUBSCRIPT
...[truncated 10029 chars]