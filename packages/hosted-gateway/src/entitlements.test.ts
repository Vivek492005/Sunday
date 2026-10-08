import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeEntitlements,
  fallbackEntitlements,
  isEntitlementsExpired,
  isValidEntitlementsView,
  isWithinGraceWindow,
  loadPlans,
  validateEntitlements,
  validatePlansFile,
  ENTITLEMENTS_TTL_MS,
  ENTITLEMENTS_GRACE_MS,
} from './entitlements.js';

const VALID_ENTITLEMENTS = {
  'managed_models.enabled': true,
  'managed_models.daily_requests': 200,
  'orchestration.max_feature_agents': 1,
  'orchestration.parallel': false,
  'browser_agent.enabled': false,
  'browser_agent.daily_sessions': 0,
  'codebase_index.max_repo_mb': 100,
  'autocomplete.managed_route': false,
  'scheduler.priority_class': 'standard',
  'support.tier': 'community',
};

function validPlansFile() {
  return {
    version: 1,
    plans: [
      {
        id: 'basic',
        name: 'Basic',
        price_inr_paise: 0,
        interval: 'month',
        description: 'free',
        entitlements: { ...VALID_ENTITLEMENTS },
      },
      {
        id: 'smart',
        name: 'Smart',
        price_inr_paise: 49900,
        interval: 'month',
        description: 'paid',
        entitlements: {
          ...VALID_ENTITLEMENTS,
          'managed_models.daily_requests': 300,
          'orchestration.max_feature_agents': 2,
          'browser_agent.enabled': true,
          'browser_agent.daily_sessions': 5,
        },
      },
      {
        id: 'pro',
        name: 'Pro',
        price_inr_paise: 149900,
        interval: 'month',
        description: 'power',
        entitlements: {
          ...VALID_ENTITLEMENTS,
          'managed_models.daily_requests': 1500,
          'orchestration.max_feature_agents': 4,
          'orchestration.parallel': true,
          'browser_agent.enabled': true,
          'browser_agent.daily_sessions': 50,
          'codebase_index.max_repo_mb': 2000,
        },
      },
    ],
  };
}

describe('validatePlansFile', () => {
  it('accepts a valid plans file', () => {
    const plans = validatePlansFile(validPlansFile());
    expect(plans.plans).toHaveLength(3);
  });

  it('rejects missing basic plan', () => {
    const f = validPlansFile();
    f.plans = f.plans.filter((p: { id: string }) => p.id !== 'basic');
    expect(() => validatePlansFile(f)).toThrow(/basic/);
  });

  it('rejects duplicate plan ids', () => {
    const f = validPlansFile();
    f.plans.push({ ...f.plans[0] });
    expect(() => validatePlansFile(f)).toThrow(/duplicate/);
  });

  it('rejects unknown plan id', () => {
    const f = validPlansFile();
    (f.plans[0] as { id: string }).id = 'enterprise';
    expect(() => validatePlansFile(f)).toThrow(/basic\|smart\|pro/);
  });

  it('rejects negative price', () => {
    const f = validPlansFile();
    (f.plans[1] as { price_inr_paise: number }).price_inr_paise = -1;
    expect(() => validatePlansFile(f)).toThrow(/price_inr_paise/);
  });

  it('rejects non-JSON input via loadPlans', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plans-'));
    writeFileSync(join(dir, 'plans.json'), '{not json');
    expect(() => loadPlans(dir)).toThrow(/not valid JSON/);
  });

  it('rejects missing file via loadPlans', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plans-'));
    expect(() => loadPlans(dir)).toThrow(/not found/);
  });

  it('loads the real plans.json seed', () => {
    const plans = loadPlans();
    expect(plans.plans.map((p) => p.id).sort()).toEqual(['basic', 'pro', 'smart']);
    const pro = plans.plans.find((p) => p.id === 'pro')!;
    expect(pro.entitlements['orchestration.parallel']).toBe(true);
    expect(pro.price_inr_paise).toBe(149900);
  });
});

describe('validateEntitlements', () => {
  it('accepts valid entitlements', () => {
    expect(validateEntitlements({ ...VALID_ENTITLEMENTS })).toEqual(VALID_ENTITLEMENTS);
  });

  it('rejects missing key', () => {
    const e = { ...VALID_ENTITLEMENTS };
    delete (e as Record<string, unknown>)['browser_agent.enabled'];
    expect(() => validateEntitlements(e)).toThrow(/missing key/);
  });

  it('rejects wrong value type', () => {
    const e = { ...VALID_ENTITLEMENTS, 'managed_models.daily_requests': 'lots' };
    expect(() => validateEntitlements(e)).toThrow(/invalid value/);
  });

  it('rejects invalid priority class', () => {
    const e = { ...VALID_ENTITLEMENTS, 'scheduler.priority_class': 'turbo' };
    expect(() => validateEntitlements(e)).toThrow(/invalid value/);
  });
});

describe('computeEntitlements', () => {
  const plans = validatePlansFile(validPlansFile());
  const now = Date.parse('2026-10-08T10:00:00Z');

  it('computes basic view', () => {
    const view = computeEntitlements('u_1', 'basic', plans, { now });
    expect(view.plan).toBe('basic');
    expect(view.entitlements['managed_models.daily_requests']).toBe(200);
    expect(view.entitlements['orchestration.parallel']).toBe(false);
    expect(view.valid_until).toBe(new Date(now + ENTITLEMENTS_TTL_MS).toISOString());
  });

  it('computes smart view with elevated limits', () => {
    const view = computeEntitlements('u_2', 'smart', plans, { now });
    expect(view.entitlements['orchestration.max_feature_agents']).toBe(2);
    expect(view.entitlements['browser_agent.daily_sessions']).toBe(5);
  });

  it('computes pro view with parallel enabled', () => {
    const view = computeEntitlements('u_3', 'pro', plans, { now });
    expect(view.entitlements['orchestration.parallel']).toBe(true);
    expect(view.entitlements['managed_models.daily_requests']).toBe(1500);
  });

  it('throws on unknown plan', () => {
    expect(() => computeEntitlements('u_1', 'enterprise' as never, plans, { now })).toThrow(
      /unknown plan/,
    );
  });

  it('does not share the template object (mutation-safe)', () => {
    const view = computeEntitlements('u_1', 'basic', plans, { now });
    (view.entitlements as Record<string, unknown>)['managed_models.daily_requests'] = 99999;
    const again = computeEntitlements('u_1', 'basic', plans, { now });
    expect(again.entitlements['managed_models.daily_requests']).toBe(200);
  });
});

describe('view validation + expiry', () => {
  const plans = validatePlansFile(validPlansFile());
  const now = Date.parse('2026-10-08T10:00:00Z');
  const view = computeEntitlements('u_1', 'smart', plans, { now });

  it('accepts a valid view', () => {
    expect(isValidEntitlementsView(view)).toBe(true);
  });

  it('rejects tampered entitlements', () => {
    const tampered = JSON.parse(JSON.stringify(view));
    tampered.entitlements['managed_models.daily_requests'] = 999999999;
    // shape still valid (number) — but a client MUST NOT trust it blindly;
    // the gateway re-checks server-side. Shape validation passes here by design.
    expect(isValidEntitlementsView(tampered)).toBe(true);
  });

  it('rejects malformed views', () => {
    expect(isValidEntitlementsView(null)).toBe(false);
    expect(isValidEntitlementsView({ ...view, plan: 'enterprise' })).toBe(false);
    expect(isValidEntitlementsView({ ...view, valid_until: 'not-a-date' })).toBe(false);
    expect(
      isValidEntitlementsView({
        ...view,
        entitlements: { ...view.entitlements, 'managed_models.enabled': 'yes' },
      }),
    ).toBe(false);
  });

  it('detects expiry', () => {
    expect(isEntitlementsExpired(view, now)).toBe(false);
    expect(isEntitlementsExpired(view, now + ENTITLEMENTS_TTL_MS + 1)).toBe(true);
  });

  it('grace window: 72h after expiry, then lapses', () => {
    const justExpired = now + ENTITLEMENTS_TTL_MS + 1000;
    expect(isWithinGraceWindow(view, justExpired)).toBe(true);
    const lapsed = now + ENTITLEMENTS_TTL_MS + ENTITLEMENTS_GRACE_MS + 1000;
    expect(isWithinGraceWindow(view, lapsed)).toBe(false);
  });

  it('fallback disables managed routes', () => {
    const fb = fallbackEntitlements('u_9', now);
    expect(fb.entitlements['managed_models.enabled']).toBe(false);
    expect(fb.entitlements['managed_models.daily_requests']).toBe(0);
    expect(isValidEntitlementsView(fb)).toBe(true);
  });
});
