/**
 * @sunday/org — F15 Team Governance Layer: schema.
 *
 * `sunday-org.json` is a git-distributed, SIGNED org policy bundle. It carries
 * shared rules, allowed models/providers, the F7 policy-profile lock, F8 hooks,
 * and F1 budgets — everything a team admin wants enforced for every member.
 *
 * The bundle is signed (ed25519, see signing.ts). The daemon/IDE verifies the
 * signature on load; a tampered bundle is rejected outright.
 */
import { z } from 'zod';
import { HookDefSchema } from '@sunday/hooks';

/** F7 policy profiles — kept structurally identical to sundayd's PolicyProfile. */
export const OrgPolicyProfileSchema = z.enum(['cautious', 'balanced', 'autopilot']);
export type OrgPolicyProfile = z.infer<typeof OrgPolicyProfileSchema>;

/** F1 budget limit shape — { soft?, hard? } gateway-request counts. */
export const OrgBudgetLimitSchema = z.object({
  /** Warn when spend reaches this (agent continues). */
  soft: z.number().int().nonnegative().optional(),
  /** Pause when spend reaches this (agent stops until continued). */
  hard: z.number().int().nonnegative().optional(),
});
export type OrgBudgetLimit = z.infer<typeof OrgBudgetLimitSchema>;

export const OrgBudgetsSchema = z.object({
  task: OrgBudgetLimitSchema.optional(),
  session: OrgBudgetLimitSchema.optional(),
  day: OrgBudgetLimitSchema.optional(),
});
export type OrgBudgets = z.infer<typeof OrgBudgetsSchema>;

export const OrgRuleSchema = z.object({
  /** Short stable name, used in logs + prompt headers. */
  name: z.string().min(1).max(120),
  /** The rule text injected ahead of the model. */
  text: z.string().min(1).max(8000),
});
export type OrgRule = z.infer<typeof OrgRuleSchema>;

export const OrgPolicyBlockSchema = z.object({
  profile: OrgPolicyProfileSchema,
  /** When true the member cannot change the profile (default true). */
  locked: z.boolean().default(true),
});
export type OrgPolicyBlock = z.infer<typeof OrgPolicyBlockSchema>;

export const OrgSignatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  /** Key id so the verifier can pick the right trusted public key. */
  keyId: z.string().min(1).max(120),
  /** Hex-encoded ed25519 signature over the canonical bundle bytes. */
  value: z.string().regex(/^[0-9a-f]{128}$/),
});
export type OrgSignature = z.infer<typeof OrgSignatureSchema>;

/**
 * Setting keys the org locks. Exact keys (`policy.profile`) or prefix
 * wildcards (`budgets.*`). A locked key can never be overridden by user or
 * repo layers — see merge.ts.
 */
export const LOCKABLE_SETTINGS = [
  'policy.profile',
  'budgets.task',
  'budgets.session',
  'budgets.day',
  'models.allowed',
  'providers.allowed',
  'hooks',
  'rules',
] as const;
export type LockableSetting = (typeof LOCKABLE_SETTINGS)[number];

export const OrgBundleSchema = z.object({
  version: z.literal(1),
  org: z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
  }),
  /** Shared rules — prepended ahead of user/repo rules (highest precedence). */
  rules: z.array(OrgRuleSchema).max(200).default([]),
  /** Null/omitted = unrestricted. */
  allowedModels: z.array(z.string().min(1)).max(500).optional(),
  allowedProviders: z.array(z.string().min(1)).max(100).optional(),
  /** F7 policy profile + lock. */
  policy: OrgPolicyBlockSchema.optional(),
  /** F1 budgets. */
  budgets: OrgBudgetsSchema.optional(),
  /** F8 hooks — always applied; members may add their own on top. */
  hooks: z.array(HookDefSchema).max(100).default([]),
  /** Which settings the org locks (org > user > repo, locked wins always). */
  locked: z.array(z.string().min(1)).default([]),
  /**
   * ed25519 signature over the canonical bundle bytes. Required in
   * production; the loader rejects unsigned bundles unless the caller
   * explicitly passes `allowUnsigned` (dev only).
   */
  signature: OrgSignatureSchema.optional(),
});
export type OrgBundle = z.infer<typeof OrgBundleSchema>;

/** The same bundle shape without the signature — what actually gets signed. */
export const UnsignedOrgBundleSchema = OrgBundleSchema.omit({ signature: true });
/** Output type: defaults (rules/hooks/locked) are applied. */
export type UnsignedOrgBundle = z.infer<typeof UnsignedOrgBundleSchema>;
/** Input type: defaulted fields may be omitted by the admin. */
export type UnsignedOrgBundleInput = z.input<typeof UnsignedOrgBundleSchema>;
/** A bundle that definitely carries a signature (post-signing). */
export type SignedOrgBundle = UnsignedOrgBundle & { signature: OrgSignature };

/** Parse + validate a raw sunday-org.json payload. Throws on invalid. */
export function parseOrgBundle(raw: unknown): OrgBundle {
  return OrgBundleSchema.parse(raw);
}

/** Safe parse — returns null instead of throwing. */
export function tryParseOrgBundle(raw: unknown): OrgBundle | null {
  const r = OrgBundleSchema.safeParse(raw);
  return r.success ? r.data : null;
}
