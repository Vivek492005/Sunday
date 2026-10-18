/**
 * @sunday/org — F15: policy merge.
 *
 * Merge order: org > user > repo. Settings the org locks (see `locked` in
 * the bundle) can NEVER be overridden by user or repo layers.
 *
 * Layers:
 *   - org:  the verified OrgBundle (highest precedence)
 *   - user: ~/.sunday/policy.json (member's own preferences)
 *   - repo: .sunday/policy.json (project defaults, git-distributed)
 *
 * Setting keys use the dotted namespace from schema.ts LOCKABLE_SETTINGS,
 * e.g. `policy.profile`, `budgets.day`, `models.allowed`. `isLocked()`
 * supports exact keys and `prefix.*` wildcards.
 */

import type { HookDef } from '@sunday/hooks';
import type { OrgBundle, OrgBudgets, OrgPolicyProfile, OrgRule } from './schema.js';

/** One non-org policy layer (user or repo). All fields optional. */
export interface PolicyLayer {
  rules?: OrgRule[];
  allowedModels?: string[];
  allowedProviders?: string[];
  policyProfile?: OrgPolicyProfile;
  budgets?: OrgBudgets;
  hooks?: HookDef[];
}

/** The effective policy after merging org > user > repo. */
export interface EffectivePolicy {
  /** Rules concatenated org-first (org rules get highest prompt precedence). */
  rules: OrgRule[];
  /** null = unrestricted. */
  allowedModels: string[] | null;
  allowedProviders: string[] | null;
  policyProfile: OrgPolicyProfile;
  budgets: OrgBudgets;
  /** Hooks concatenated org-first. */
  hooks: HookDef[];
  /** Setting keys locked by the org (exact or `prefix.*`). */
  locked: string[];
  /** Org id, or null when no org bundle is active. */
  orgId: string | null;
}

export const DEFAULT_PROFILE: OrgPolicyProfile = 'balanced';

/** Does a lock pattern match a setting key? Supports `*` and `prefix.*`. */
export function lockMatches(pattern: string, key: string): boolean {
  if (pattern === '*') return true;
  if (pattern === key) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return key === prefix || key.startsWith(prefix + '.');
  }
  return false;
}

/** Is a setting key locked by the org? */
export function isLocked(key: string, locked: readonly string[]): boolean {
  return locked.some((p) => lockMatches(p, key));
}

/**
 * Resolve one setting across layers. When the key is locked and the org
 * defines a value, the org value ALWAYS wins — user/repo are ignored.
 * Otherwise normal precedence: user ?? repo ?? org.
 */
export function resolveSetting<T>(
  key: string,
  locked: readonly string[],
  orgVal: T | undefined,
  userVal: T | undefined,
  repoVal: T | undefined,
): T | undefined {
  if (isLocked(key, locked) && orgVal !== undefined) return orgVal;
  if (userVal !== undefined) return userVal;
  if (repoVal !== undefined) return repoVal;
  return orgVal;
}

function mergeBudgets(
  locked: readonly string[],
  org: OrgBudgets | undefined,
  user: OrgBudgets | undefined,
  repo: OrgBudgets | undefined,
): OrgBudgets {
  const out: OrgBudgets = {};
  for (const scope of ['task', 'session', 'day'] as const) {
    const v = resolveSetting(`budgets.${scope}`, locked, org?.[scope], user?.[scope], repo?.[scope]);
    if (v !== undefined) out[scope] = v;
  }
  return out;
}

/**
 * Merge org > user > repo into the effective policy.
 * Pass null/undefined for layers that don't exist.
 */
export function mergePolicies(
  org: OrgBundle | null | undefined,
  user: PolicyLayer | null | undefined,
  repo: PolicyLayer | null | undefined,
): EffectivePolicy {
  const locked: string[] = org?.locked ?? [];

  // Rules: concatenated org-first so org rules get highest prompt precedence.
  // (Rules are additive, never "overridden" — lock on `rules` means the org
  // rules cannot be removed, which concatenation guarantees.)
  const rules: OrgRule[] = [...(org?.rules ?? []), ...(user?.rules ?? []), ...(repo?.rules ?? [])];

  // Hooks: same additive semantics, org first.
  const hooks: HookDef[] = [...(org?.hooks ?? []), ...(user?.hooks ?? []), ...(repo?.hooks ?? [])];

  return {
    rules,
    allowedModels:
      resolveSetting('models.allowed', locked, org?.allowedModels, user?.allowedModels, repo?.allowedModels) ??
      null,
    allowedProviders:
      resolveSetting(
        'providers.allowed',
        locked,
        org?.allowedProviders,
        user?.allowedProviders,
        repo?.allowedProviders,
      ) ?? null,
    policyProfile:
      resolveSetting('policy.profile', locked, org?.policy?.profile, user?.policyProfile, repo?.policyProfile) ??
      DEFAULT_PROFILE,
    budgets: mergeBudgets(locked, org?.budgets, user?.budgets, repo?.budgets),
    hooks,
    locked,
    orgId: org?.org.id ?? null,
  };
}

/**
 * Strip locked keys from a proposed layer (user/repo) — useful for UIs that
 * want to show "this change would be ignored". Returns the removed keys.
 */
export function stripLockedKeys(layer: PolicyLayer, locked: readonly string[]): string[] {
  const removed: string[] = [];
  const check = (key: string, present: boolean, del: () => void) => {
    if (present && isLocked(key, locked)) {
      del();
      removed.push(key);
    }
  };
  check('models.allowed', layer.allowedModels !== undefined, () => delete layer.allowedModels);
  check('providers.allowed', layer.allowedProviders !== undefined, () => delete layer.allowedProviders);
  check('policy.profile', layer.policyProfile !== undefined, () => delete layer.policyProfile);
  check('budgets.task', layer.budgets?.task !== undefined, () => delete layer.budgets!.task);
  check('budgets.session', layer.budgets?.session !== undefined, () => delete layer.budgets!.session);
  check('budgets.day', layer.budgets?.day !== undefined, () => delete layer.budgets!.day);
  return removed;
}
