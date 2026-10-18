/**
 * @sunday/org — F15 Team Governance Layer.
 *
 * Signed org policy bundles (`sunday-org.json`), org > user > repo merge with
 * lock enforcement, and a JSONL audit trail. File-based first, per the spec —
 * SSO/server come later on demand signal.
 */

export {
  OrgBundleSchema,
  UnsignedOrgBundleSchema,
  OrgSignatureSchema,
  OrgPolicyProfileSchema,
  OrgBudgetLimitSchema,
  OrgBudgetsSchema,
  OrgRuleSchema,
  OrgPolicyBlockSchema,
  LOCKABLE_SETTINGS,
  parseOrgBundle,
  tryParseOrgBundle,
  type OrgBundle,
  type UnsignedOrgBundle,
  type OrgSignature,
  type OrgPolicyProfile,
  type OrgBudgetLimit,
  type OrgBudgets,
  type OrgRule,
  type OrgPolicyBlock,
  type LockableSetting,
  type SignedOrgBundle,
  type UnsignedOrgBundleInput,
} from './schema.js';

export {
  canonicalJson,
  bundleSignBytes,
  generateOrgKeyPair,
  signOrgBundle,
  verifyOrgBundle,
  OrgSignatureError,
  type OrgKeyPair,
} from './signing.js';

export {
  loadOrgPolicy,
  findOrgBundle,
  OrgLoadError,
  type LoadOrgPolicyOptions,
  type LoadedOrgPolicy,
} from './loader.js';

export {
  mergePolicies,
  resolveSetting,
  isLocked,
  lockMatches,
  stripLockedKeys,
  DEFAULT_PROFILE,
  type PolicyLayer,
  type EffectivePolicy,
} from './merge.js';

export {
  AuditLog,
  getAuditLog,
  auditDirExists,
  AuditEventSchema,
  AuditEventTypeSchema,
  type AuditEvent,
  type AuditEventType,
  type AuditLogOptions,
} from './audit.js';
