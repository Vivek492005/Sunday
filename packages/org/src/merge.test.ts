import { describe, it, expect } from 'vitest';
import { mergePolicies, resolveSetting, isLocked, lockMatches, stripLockedKeys } from './merge.js';
import { signOrgBundle, generateOrgKeyPair } from './signing.js';
import type { SignedOrgBundle, UnsignedOrgBundleInput } from './schema.js';

function orgBundle(overrides: Partial<UnsignedOrgBundleInput> = {}): SignedOrgBundle {
  const keys = generateOrgKeyPair('k');
  return signOrgBundle(
    {
      version: 1,
      org: { id: 'acme', name: 'Acme' },
      rules: [{ name: 'org-rule', text: 'Org says hi.' }],
      ...overrides,
    },
    keys.privateKey,
    keys.keyId,
  );
}

describe('lockMatches', () => {
  it('exact match', () => {
    expect(lockMatches('policy.profile', 'policy.profile')).toBe(true);
    expect(lockMatches('policy.profile', 'policy.other')).toBe(false);
  });
  it('prefix wildcard', () => {
    expect(lockMatches('budgets.*', 'budgets.day')).toBe(true);
    expect(lockMatches('budgets.*', 'budgets')).toBe(true);
    expect(lockMatches('budgets.*', 'models.allowed')).toBe(false);
  });
  it('global wildcard', () => {
    expect(lockMatches('*', 'anything.at.all')).toBe(true);
  });
});

describe('isLocked', () => {
  it('detects locked keys', () => {
    expect(isLocked('policy.profile', ['policy.profile'])).toBe(true);
    expect(isLocked('budgets.day', ['budgets.*'])).toBe(true);
    expect(isLocked('models.allowed', ['policy.profile'])).toBe(false);
    expect(isLocked('x', [])).toBe(false);
  });
});

describe('resolveSetting', () => {
  it('locked + org value => org always wins', () => {
    expect(resolveSetting('policy.profile', ['policy.profile'], 'cautious', 'autopilot', 'balanced')).toBe(
      'cautious',
    );
  });
  it('unlocked => user > repo > org', () => {
    expect(resolveSetting('policy.profile', [], 'cautious', 'autopilot', 'balanced')).toBe('autopilot');
    expect(resolveSetting('policy.profile', [], 'cautious', undefined, 'balanced')).toBe('balanced');
    expect(resolveSetting('policy.profile', [], 'cautious', undefined, undefined)).toBe('cautious');
    expect(resolveSetting('policy.profile', [], undefined, undefined, undefined)).toBeUndefined();
  });
  it('locked but org unset => falls through to user', () => {
    expect(resolveSetting('policy.profile', ['policy.profile'], undefined, 'autopilot', undefined)).toBe(
      'autopilot',
    );
  });
});

describe('mergePolicies', () => {
  it('org > user > repo precedence for profile', () => {
    const org = orgBundle({ policy: { profile: 'cautious', locked: false }, locked: [] });
    const eff = mergePolicies(org, { policyProfile: 'autopilot' }, { policyProfile: 'balanced' });
    // unlocked: user wins
    expect(eff.policyProfile).toBe('autopilot');
  });

  it('org-locked profile cannot be overridden by user', () => {
    const org = orgBundle({ policy: { profile: 'cautious', locked: true }, locked: ['policy.profile'] });
    const eff = mergePolicies(org, { policyProfile: 'autopilot' }, { policyProfile: 'balanced' });
    expect(eff.policyProfile).toBe('cautious');
  });

  it('org-locked budgets cannot be overridden', () => {
    const org = orgBundle({
      budgets: { day: { hard: 100 } },
      locked: ['budgets.day'],
    });
    const eff = mergePolicies(
      org,
      { budgets: { day: { hard: 9999 } } },
      { budgets: { day: { hard: 5000 } } },
    );
    expect(eff.budgets.day?.hard).toBe(100);
  });

  it('unlocked budgets merge per-scope with user winning', () => {
    const org = orgBundle({ budgets: { day: { hard: 100 } }, locked: [] });
    const eff = mergePolicies(org, { budgets: { task: { soft: 5 } } }, undefined);
    expect(eff.budgets.day?.hard).toBe(100); // org fills what user doesn't set
    expect(eff.budgets.task?.soft).toBe(5);
  });

  it('allowedModels: locked org list wins', () => {
    const org = orgBundle({ allowedModels: ['llama-3.3-70b'], locked: ['models.allowed'] });
    const eff = mergePolicies(org, { allowedModels: ['gpt-4'] }, undefined);
    expect(eff.allowedModels).toEqual(['llama-3.3-70b']);
  });

  it('rules concatenate org-first', () => {
    const org = orgBundle({ rules: [{ name: 'o', text: 'org' }] });
    const eff = mergePolicies(
      org,
      { rules: [{ name: 'u', text: 'user' }] },
      { rules: [{ name: 'r', text: 'repo' }] },
    );
    expect(eff.rules.map((r) => r.name)).toEqual(['o', 'u', 'r']);
  });

  it('hooks concatenate org-first', () => {
    const org = orgBundle({
      hooks: [
        {
          name: 'org-hook',
          event: 'pre_commit',
          match: { tools: [], paths: [] },
          actions: [{ type: 'annotate', text: 'org' }],
          enabled: true,
        },
      ],
    });
    const eff = mergePolicies(org, undefined, undefined);
    expect(eff.hooks.map((h) => h.name)).toEqual(['org-hook']);
  });

  it('no org => user > repo, defaults otherwise', () => {
    const eff = mergePolicies(null, { policyProfile: 'autopilot' }, { policyProfile: 'cautious' });
    expect(eff.policyProfile).toBe('autopilot');
    expect(eff.orgId).toBeNull();
    expect(eff.allowedModels).toBeNull();
    const eff2 = mergePolicies(null, null, null);
    expect(eff2.policyProfile).toBe('balanced');
    expect(eff2.rules).toEqual([]);
  });

  it('locked list is surfaced on the effective policy', () => {
    const org = orgBundle({ locked: ['policy.profile', 'budgets.*'] });
    const eff = mergePolicies(org, undefined, undefined);
    expect(isLocked('budgets.task', eff.locked)).toBe(true);
  });
});

describe('stripLockedKeys', () => {
  it('removes locked keys from a user layer and reports them', () => {
    const layer = { policyProfile: 'autopilot' as const, allowedModels: ['x'] };
    const removed = stripLockedKeys(layer, ['policy.profile']);
    expect(removed).toEqual(['policy.profile']);
    expect(layer.policyProfile).toBeUndefined();
    expect(layer.allowedModels).toEqual(['x']);
  });
});
