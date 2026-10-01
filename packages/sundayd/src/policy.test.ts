// PolicyGate risk-class-M approval tests: dangerous tools (MCP tools,
// `remember`) are denied until explicitly approved; approvals are per
// instance (per daemon session lifetime).
import { describe, expect, it } from 'vitest';
import { PolicyGate } from './policy.js';

describe('PolicyGate dangerous-tool approvals', () => {
  it('denies a dangerous tool until approved', () => {
    const p = new PolicyGate();
    p.markDangerous('mcp__github__create_issue');
    const d = p.evaluate('mcp__github__create_issue');
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/requires explicit user approval/);
    // Non-dangerous tools are unaffected.
    expect(p.evaluate('read_file')).toEqual({ allow: true });
  });

  it('approve() permits the tool; revoke() removes the permission', () => {
    const p = new PolicyGate();
    p.markDangerous('remember');
    p.approve('remember');
    expect(p.isApproved('remember')).toBe(true);
    expect(p.evaluate('remember')).toEqual({ allow: true });
    p.revoke('remember');
    expect(p.isApproved('remember')).toBe(false);
    expect(p.evaluate('remember').allow).toBe(false);
  });

  it('allow overrides satisfy the approval requirement without approve()', () => {
    const p = new PolicyGate({ allow: ['mcp__x__y'] });
    p.markDangerous('mcp__x__y');
    expect(p.evaluate('mcp__x__y')).toEqual({ allow: true });
  });

  it('approvals option pre-approves dangerous tools', () => {
    const p = new PolicyGate({ approvals: ['remember'] });
    p.markDangerous('remember');
    expect(p.evaluate('remember')).toEqual({ allow: true });
  });

  it('explicit deny beats an approval', () => {
    const p = new PolicyGate({ deny: ['remember'] });
    p.markDangerous('remember');
    p.approve('remember');
    expect(p.evaluate('remember').allow).toBe(false);
  });

  it('an approval bypasses deny-all mode for that tool only', () => {
    const p = new PolicyGate({ mode: 'deny-all' });
    p.markDangerous('remember');
    p.approve('remember');
    expect(p.evaluate('remember')).toEqual({ allow: true });
    expect(p.evaluate('read_file').allow).toBe(false);
  });

  it('unmarkDangerous lifts the approval requirement', () => {
    const p = new PolicyGate();
    p.markDangerous('remember');
    p.unmarkDangerous('remember');
    expect(p.isDangerous('remember')).toBe(false);
    expect(p.evaluate('remember')).toEqual({ allow: true });
  });

  it('dangerousTools()/approvedTools() report sorted names', () => {
    const p = new PolicyGate();
    p.markDangerous('mcp__b__t');
    p.markDangerous('mcp__a__t');
    p.approve('mcp__b__t');
    expect(p.dangerousTools()).toEqual(['mcp__a__t', 'mcp__b__t']);
    expect(p.approvedTools()).toEqual(['mcp__b__t']);
  });

  it('explicit approval wins over read-only mode for that tool', () => {
    const p = new PolicyGate({ mode: 'read-only' });
    p.markDangerous('write_file');
    // Dangerous check fires first with the approval reason.
    expect(p.evaluate('write_file').allow).toBe(false);
    // After approval the explicit user consent wins over the mode too.
    p.approve('write_file');
    expect(p.evaluate('write_file')).toEqual({ allow: true });
    // …but unapproved tools still follow the mode.
    expect(p.evaluate('edit_file').allow).toBe(false);
  });
});
