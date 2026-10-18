# `@sunday/org` — F15 Team Governance Layer

Signed org policy bundles (`sunday-org.json`), org > user > repo merge with
lock enforcement, and a JSONL audit trail. File-based first, per the F15
spec — SSO/server come later on demand signal.

## Quick start — run Sunday in your team

**1. Admin: generate a signing key**

```ts
import { generateOrgKeyPair } from '@sunday/org';
const keys = generateOrgKeyPair('team-key-2026');
// keys.publicKey  -> distribute to every member (SUNDAY_ORG_PUBLIC_KEY or ~/.sunday/org-keys/)
// keys.privateKey -> keep secret, used only to sign bundles
```

**2. Admin: write + sign the bundle**

```ts
import { signOrgBundle } from '@sunday/org';
import { writeFileSync } from 'node:fs';

const signed = signOrgBundle(
  {
    version: 1,
    org: { id: 'acme', name: 'Acme Corp' },
    rules: [{ name: 'no-secrets', text: 'Never commit secrets or .env files.' }],
    allowedModels: ['llama-3.3-70b', 'qwen-2.5-coder-32b'],
    policy: { profile: 'balanced', locked: true },   // F7 profile lock
    budgets: { day: { soft: 150, hard: 200 } },       // F1 budgets
    hooks: [/* F8 HookDef... */],
    locked: ['policy.profile', 'budgets.*', 'models.allowed'],
  },
  keys.privateKey,
  keys.keyId,
);
writeFileSync('sunday-org.json', JSON.stringify(signed, null, 2));
// commit sunday-org.json to git — members pull it like any other file
```

**3. Member: the bundle is verified on load**

```ts
import { loadOrgPolicy, mergePolicies } from '@sunday/org';

// throws OrgSignatureError if tampered / unsigned / wrong key
const { bundle } = loadOrgPolicy('./sunday-org.json', {
  publicKey: process.env.SUNDAY_ORG_PUBLIC_KEY,
});

const effective = mergePolicies(bundle, userLayer /* ~/.sunday/policy.json */, repoLayer /* .sunday/policy.json */);
// effective.policyProfile === 'balanced' even if the user asked for autopilot,
// because the org locked `policy.profile`.
```

## Merge order

`org > user > repo`. A setting the org locks (`locked: ['policy.profile']`,
also supports `budgets.*` and `*` wildcards) can **never** be overridden by
the user or repo layers — `resolveSetting()` enforces this, and
`stripLockedKeys()` reports which user keys would be ignored.

Rules and hooks are additive: org entries come first (highest prompt
precedence), then user, then repo.

## Audit trail

```ts
import { AuditLog } from '@sunday/org';
const audit = new AuditLog(); // ~/.sunday/audit/<date>.jsonl

audit.recordApproval({ actor: 'alice@acme.com', orgId: 'acme',
  summary: 'approved run_terminal(npm test)' });
audit.recordBudgetBreach({ actor: 'session-1', orgId: 'acme',
  summary: 'hard budget hit on scope day (200/200)' });

// compliance export
const jsonl = audit.export({ from: '2026-10-01', to: '2026-10-31' });
```

Recorded event types: `approval` (F7), `budget-breach` (F1),
`policy-decision` (F7), `hook-block` (F8), `loop-guard` (F2),
`session` (F6), `org-policy` (F15), `custom`.

## Security model

- Bundles are **ed25519-signed** over canonical JSON (sorted keys, no
  whitespace). The signature covers everything except the signature block.
- `signOrgBundle` normalizes through the schema first, so omitted defaulted
  fields can't cause sign/verify mismatches.
- Unsigned bundles are **rejected by default** (`allowUnsigned` is dev-only).
- Trusted keys: explicit option → `SUNDAY_ORG_PUBLIC_KEY` env →
  `~/.sunday/org-keys/<keyId>.pem`.
