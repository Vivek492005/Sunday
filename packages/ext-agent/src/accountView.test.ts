// Tests for the Sunday Account status bar UI shell (Phase 9.a): the pure
// label/quick-pick/state logic in accountView.ts. `vscode` is mocked; only the
// pure functions are exercised here.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  DEFAULT_PLAN,
  GOOGLE_PROVIDER_ID,
  GOOGLE_SCOPES,
  GOOGLE_SIGN_OUT_COMMAND,
  accountStatusBarLabel,
  accountStatusBarTooltip,
  buildSignedInPickItems,
  buildSignedOutPickItems,
  deriveAccountState,
  normalizePlan,
  signedInPickAction,
  signedOutPickAction,
  type AccountPickItem,
} from './accountView.js';

const makeSession = (label: string) =>
  ({
    id: 'session-1',
    accessToken: 'token',
    account: { id: 'acct-1', label },
    scopes: ['openid', 'email', 'profile'],
  }) as any;

describe('normalizePlan', () => {
  it('defaults to Basic when entitlements are unavailable', () => {
    expect(normalizePlan(undefined)).toBe('Basic');
    expect(normalizePlan('')).toBe('Basic');
    expect(normalizePlan('   ')).toBe('Basic');
  });

  it('title-cases known and unknown plans', () => {
    expect(normalizePlan('basic')).toBe('Basic');
    expect(normalizePlan('Basic')).toBe('Basic');
    expect(normalizePlan('SMART')).toBe('Smart');
    expect(normalizePlan(' pro ')).toBe('Pro');
    expect(normalizePlan('enterprise')).toBe('Enterprise');
  });

  it('DEFAULT_PLAN is Basic', () => {
    expect(DEFAULT_PLAN).toBe('Basic');
  });
});

describe('deriveAccountState', () => {
  it('is signed out with the Basic plan when there is no session', () => {
    expect(deriveAccountState(undefined)).toEqual({ signedIn: false, plan: 'Basic' });
  });

  it('derives email + Basic plan from a session without Sunday info', () => {
    expect(deriveAccountState(makeSession('vivek@example.com'))).toEqual({
      signedIn: true,
      email: 'vivek@example.com',
      plan: 'Basic',
    });
  });

  it('takes the plan from the Sunday session when present', () => {
    expect(deriveAccountState(makeSession('vivek@example.com'), { plan: 'smart' })).toEqual({
      signedIn: true,
      email: 'vivek@example.com',
      plan: 'Smart',
    });
  });

  it('falls back to Basic when the Sunday session has no plan', () => {
    expect(deriveAccountState(makeSession('vivek@example.com'), {})).toEqual({
      signedIn: true,
      email: 'vivek@example.com',
      plan: 'Basic',
    });
  });

  it('falls back to the Sunday session email when the auth session has none', () => {
    const session = { ...makeSession(''), account: { id: 'acct-1', label: '' } } as any;
    expect(deriveAccountState(session, { email: 'backup@example.com' })).toEqual({
      signedIn: true,
      email: 'backup@example.com',
      plan: 'Basic',
    });
  });
});

describe('accountStatusBarLabel', () => {
  it('shows the signed-out prompt', () => {
    expect(accountStatusBarLabel({ signedIn: false, plan: 'Basic' })).toBe(
      '$(sign-in) Sign in to Sunday',
    );
  });

  it('shows email + plan badge when signed in', () => {
    expect(
      accountStatusBarLabel({ signedIn: true, email: 'vivek@example.com', plan: 'Basic' }),
    ).toBe('$(account) vivek@example.com · Basic');
  });

  it('reflects a non-Basic plan', () => {
    expect(
      accountStatusBarLabel({ signedIn: true, email: 'vivek@example.com', plan: 'Smart' }),
    ).toBe('$(account) vivek@example.com · Smart');
  });

  it('handles a missing email gracefully', () => {
    expect(accountStatusBarLabel({ signedIn: true, plan: 'Basic' })).toBe(
      '$(account) Sunday account · Basic',
    );
  });
});

describe('accountStatusBarTooltip', () => {
  it('signed out', () => {
    expect(accountStatusBarTooltip({ signedIn: false, plan: 'Basic' })).toContain('Sign in');
  });

  it('signed in names the email and plan', () => {
    const tip = accountStatusBarTooltip({
      signedIn: true,
      email: 'vivek@example.com',
      plan: 'Smart',
    });
    expect(tip).toContain('vivek@example.com');
    expect(tip).toContain('Smart');
  });
});

describe('quick-pick items', () => {
  it('signed-out menu offers exactly one "Sign in with Google" row', () => {
    const items = buildSignedOutPickItems();
    expect(items).toHaveLength(1);
    expect(items[0].action).toBe('sign-in');
    expect(items[0].label).toContain('Sign in with Google');
  });

  it('signed-in menu shows email, plan badge, Sign out and Close', () => {
    const state = { signedIn: true, email: 'vivek@example.com', plan: 'Basic' };
    const items = buildSignedInPickItems(state);
    expect(items.map((i) => i.action)).toEqual(['email-info', 'sign-out', 'close']);
    expect(items[0].label).toContain('vivek@example.com');
    expect(items[0].description).toBe('Plan: Basic');
    expect(items[1].label).toContain('Sign out');
  });

  it('signed-in menu reflects a non-Basic plan badge', () => {
    const items = buildSignedInPickItems({
      signedIn: true,
      email: 'vivek@example.com',
      plan: 'Pro',
    });
    expect(items[0].description).toBe('Plan: Pro');
  });

  it('contains no upgrade or billing affordances (Phase 9.a)', () => {
    const all: AccountPickItem[] = [
      ...buildSignedOutPickItems(),
      ...buildSignedInPickItems({ signedIn: true, email: 'a@b.c', plan: 'Basic' }),
    ];
    const text = all.map((i) => `${i.label} ${i.description ?? ''}`).join(' ').toLowerCase();
    expect(text).not.toMatch(/upgrade|billing|subscribe|pricing|checkout/);
  });
});

describe('quick-pick actions', () => {
  it('signed-out: sign-in row → signIn, dismiss/Close → none', () => {
    expect(signedOutPickAction(buildSignedOutPickItems()[0])).toBe('signIn');
    expect(signedOutPickAction(undefined)).toBe('none');
  });

  it('signed-in: Sign out → signOut, others → close, dismiss → none', () => {
    const items = buildSignedInPickItems({ signedIn: true, email: 'a@b.c', plan: 'Basic' });
    expect(signedInPickAction(items[1])).toBe('signOut');
    expect(signedInPickAction(items[2])).toBe('close');
    expect(signedInPickAction(items[0])).toBe('close');
    expect(signedInPickAction(undefined)).toBe('none');
  });
});

describe('constants', () => {
  it('uses the bundled Google provider id and minimal identity scopes', () => {
    expect(GOOGLE_PROVIDER_ID).toBe('google');
    expect([...GOOGLE_SCOPES]).toEqual(['openid', 'email', 'profile']);
  });

  it('routes sign-out through the auth extension command', () => {
    expect(GOOGLE_SIGN_OUT_COMMAND).toBe('sunday.google.signOut');
  });
});
