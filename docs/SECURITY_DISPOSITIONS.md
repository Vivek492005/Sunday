# Security Finding Dispositions — 1.0-beta

Dispositions for the 4 open findings from `docs/THREAT_MODEL.md` (SEC-07, SEC-09, SEC-10, SEC-11).
Decisions made 2026-10-04 during the 1.0-beta Security gate work.

## SEC-07 — `mcp/calls/history` argsSummary may hold user-typed secrets (Low)

**Status: FIXED**

`McpHub.recordCall()` in `packages/mcp/src/hub.ts` now applies `redactSecrets()`
(from `@sunday/skills`) to `argsSummary` before the record is stored. Secrets
matching known patterns (PATs, API keys, PEM blocks, `password=` assignments)
are replaced with `[REDACTED:<label>]` markers.

- Code: `packages/mcp/src/hub.ts` (`recordCall`), new dep `@sunday/skills` on `@sunday/mcp`
- Test: `packages/mcp/src/mcp.test.ts` → "SEC-07: redacts secret shapes from history argsSummary"
- Threat-model table updated: SEC-07 → **Fixed**.

## SEC-09 — No taint escalation on state-changing calls after untrusted content (Medium)

**Status: DEFERRED (post-1.0-beta)**

Rationale:
- The baseline protections are in place: all tool output is wrapped in
  `<untrusted_tool_output>` delimiters (SEC-02) and the `INJECTION_GUARD`
  system-prompt section is always injected, instructing the model to treat
  delimited content as data, never instructions.
- Full taint escalation (tracking which tool results influenced the current
  turn, then forcing an approval gate before any state-changing call) is a
  substantial feature: it requires taint metadata through the agent loop,
  new approval UX, and careful false-positive tuning. It is not a small,
  safe code change.
- Exploitability requires a motivated attacker's page in the loop *and* the
  model ignoring both the delimiters and the guard — a meaningful bar.

Plan: design taint tracking as a post-beta feature; the delimiters + guard
remain the documented mitigation until then.

## SEC-10 — Credential-file reads (`.env`, `*.pem`) not ask-gated (Low)

**Status: DEFERRED (post-1.0-beta)**

Rationale:
- The blast radius is already contained by SEC-03: all tool output is
  secret-redacted before it reaches the model provider, so credential
  *values* never leave the machine in prompts.
- Ask-gating requires a new approval flow (detect credential-file patterns
  on read, surface an approval prompt, handle the UX in both the extension
  and CLI frontends). Not a small change.
- Severity is Low precisely because SEC-03 contains the exfiltration path;
  the remaining risk is local display of secrets to the same user who owns
  the files.

Plan: implement credential-file ask-gating alongside the SEC-09 taint work
post-beta, when the approval UX is being extended anyway.

## SEC-11 — Browser policy: DNS rebinding can bypass private-IP block (Low)

**Status: ACCEPTED (documented limitation)**

Rationale:
- The browserd network policy blocks `file://` URLs and private IP ranges
  (21 security tests cover this), and first navigation to a new origin
  requires user approval.
- DNS rebinding (attacker-controlled DNS returning a private IP *after* the
  initial check) is a known limitation of any check-then-use IP policy. A
  robust fix requires DNS pinning or resolving at socket-connect time inside
  the real Chromium network stack — the fake-driver-tested policy cannot
  fully close this, and real-Chromium verification is still pending.
- Exploitability is low: it requires the user to navigate the agent browser
  to an attacker-controlled page *and* the attacker to win a DNS race.

This remains documented in `docs/THREAT_MODEL.md` and the browserd policy
docs. Revisit when real-Chromium verification lands.
