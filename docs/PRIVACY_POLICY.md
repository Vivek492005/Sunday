# Sunday — Privacy Policy

**Last updated: October 8, 2026**

Sunday is built local-first: the IDE on your machine collects **no telemetry, no analytics, and no crash reports** — nothing phones home. This policy explains the limited cases where data does leave your machine, what our hosted gateway stores, and your rights.

## 1. Summary

| | IDE on your machine | Hosted gateway (only if you sign in) |
|---|---|---|
| Telemetry / analytics | **None, ever** | None |
| Account data | None (BYOK needs no account) | OAuth profile: email, name, avatar |
| Your code / prompts | Never sent to Sunday | Sent to AI providers for inference; **never stored by Sunday** |
| Usage metering | None | Request counts + token counts per day |

## 2. Data we collect

### 2.1 When you use the IDE without signing in (BYOK / local models)

**We collect nothing.** Your API keys stay in your shell environment — Sunday never writes them to disk. Model requests go directly from your machine to your configured provider (OpenRouter, Groq, or a local server). No Sunday-operated server is involved.

### 2.2 When you sign in to the hosted gateway

To provide the free tier, we store the minimum necessary:

- **OAuth profile** — when you sign in with GitHub, Google, or Microsoft, we receive and store your **email address, display name, and avatar URL**. We request identity scopes only (`openid email profile` or equivalent) — never access to your repos, drive, or other account data.
- **OAuth tokens** — your provider access token is verified live against the provider (short cache, never persisted). On sign-out we revoke **both** your access and refresh tokens.
- **Sunday session** — after sign-in we issue our own session token (1-hour JWT) and a refresh token (30 days, stored as a SHA-256 hash — we cannot recover the original). These authenticate your gateway requests.
- **Usage metering** — per request we record: timestamp, anonymized account key, model used, and **token counts in/out**. This enforces the 200-request daily quota and detects abuse.

### 2.3 What we never store

- **Your prompts, AI responses, code, or file contents.** The gateway's audit log records that a request happened — never what it contained. This is enforced by design and covered by automated tests.
- **Your provider API keys** (BYOK users) — they never touch our servers.
- **Precise location, device fingerprints, or browsing behavior.**

### 2.4 Update checks

If enabled, the IDE periodically asks the gateway whether a newer version exists. This check sends only your **platform (Windows/macOS/Linux) and current version number** — no personal data, no account identifier. You can disable it in settings (`sunday.update.checkOnStartup`) or check manually from the Help menu.

## 3. How we use the data

- **Authentication** — verifying who you are (OAuth profile, session tokens).
- **Quota enforcement** — counting requests against the daily free-tier limit.
- **Abuse prevention** — rate limiting per IP/account, detecting quota circumvention.
- **Service operation** — debugging outages, which never requires reading your content (because we don't store it).

We do **not** sell your data, use it for advertising, or train models on it.

## 4. Where your data goes (third parties)

When you use the hosted gateway, your inference requests are forwarded to our AI model providers — currently **OpenRouter** and **Groq** — under our commercial API agreements with them. Your prompt content is processed by these providers to generate a response; their handling of that data is governed by their own privacy policies. If a provider rate-limits us, your request may transparently fail over to another provider; this is always disclosed in the response metadata.

Other third parties:

- **OAuth providers** (GitHub, Google, Microsoft) — handle the sign-in flow; they see that you authorized Sunday.
- **Render** — hosts the gateway infrastructure (data resides on their systems under our control).
- **GitHub** — the update-check endpoint reads public release metadata; no personal data is sent.

We do not share data with any other third party.

## 5. Data retention

| Data | Retention | Deletion |
|---|---|---|
| Sunday session JWT | 1 hour (automatic expiry) | Automatic |
| Refresh tokens | 30 days, or on sign-out (immediate revocation) | Sign out, or they expire |
| OAuth profile (email, name, avatar) | While your account exists | Delete your account (see §7) |
| Usage metering (counts only) | 90 days rolling | Automatic |
| Local IDE data (sessions, memory, checkpoints) | On your machine: sessions auto-purge after 30 days (configurable via `SUNDAY_RETENTION_DAYS`) | Delete files under `~/.sunday/` anytime |

## 6. Cookies and tracking

The IDE uses **no cookies and no tracking**. The gateway sets **no tracking cookies** — authentication uses bearer tokens, not cookies. The landing website (`vivek492005.github.io/Sunday`) is a static page with no analytics.

## 7. Your rights

Whether under India's DPDP Act, the GDPR, or as a matter of our own policy, you have the right to:

- **Access** — ask what personal data we hold about you (it's the profile + metering described in §2.2).
- **Correction** — your profile mirrors your OAuth provider; update it there and re-sign-in to refresh it here.
- **Deletion** — sign out (revokes tokens immediately), then request full account deletion via the contact below; we delete your profile, sessions, and metering records.
- **Export** — request a copy of your stored data in a machine-readable format.
- **Withdraw consent** — stop using the hosted gateway at any time; the IDE's BYOK/local mode needs no account at all.

To exercise these rights, open an issue at [github.com/Vivek492005/Sunday/issues](https://github.com/Vivek492005/Sunday/issues) with "Privacy request" in the title. We respond within 30 days.

## 8. Security

- Secrets at rest: refresh tokens are SHA-256 hashed; session signing keys live in server environment, never in code or logs.
- Secrets in transit: all gateway traffic is HTTPS; OAuth follows the PKCE loopback flow (RFC 8252) with no embedded client secrets.
- Local data: session files, memory, and checkpoints are written with restrictive permissions (0600/0700), and credential filenames are never indexed.
- Secret redaction: outbound prompts pass through a redactor that strips API keys and tokens before they reach any AI provider (best-effort defense in depth — always review sensitive content before sharing it).

No system is perfectly secure; if you discover a vulnerability, please report it via a GitHub issue (mark it "Security") so we can fix it promptly.

## 9. Children

Sunday is not directed at children under 13 (or the minimum age in your jurisdiction). We do not knowingly collect data from children.

## 10. Changes to this policy

We will announce material changes in the GitHub repository and update the "Last updated" date above. Continued use of the hosted gateway after changes constitutes acceptance.

## 11. Contact

Privacy questions or requests: open an issue at [github.com/Vivek492005/Sunday/issues](https://github.com/Vivek492005/Sunday/issues) with "Privacy" in the title.

---

*This policy covers the Sunday IDE and the hosted gateway at `sunday-final-ide.onrender.com`. BYOK/local-model usage involves no Sunday-operated servers — your data relationship there is directly with your chosen provider.*
