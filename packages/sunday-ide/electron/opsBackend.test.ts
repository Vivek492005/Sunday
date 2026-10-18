/**
 * Sunday IDE — opsBackend integration tests (UI WAVE).
 *
 * Every test asserts REAL backend behavior: real route policies from
 * @sunday/gateway, real permission-intel data, real injection-firewall
 * rules, real scoreboard parsing. Daemon-dependent tests assert the
 * honest "unavailable" shape when the daemon is down — never mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  getRoutePolicies,
  getRoutingRecent,
  getPolicyInfo,
  getHooksConsent,
  getSecurityStatus,
  getScoreboard,
} from './opsBackend.js';

describe('F3 routing (opsBackend)', () => {
  it('returns the real route policy table from @sunday/gateway', () => {
    const policies = getRoutePolicies();
    expect(policies.length).toBeGreaterThan(0);
    const taskClasses = policies.map((p) => p.taskClass);
    // Spec mapping: plan/architect → strong, edit/apply → fast, autocomplete → tiny, verify → independent
    for (const tc of ['plan', 'architect', 'edit', 'apply', 'autocomplete', 'verify', 'default']) {
      expect(taskClasses).toContain(tc);
    }
    for (const p of policies) {
      expect(typeof p.primary).toBe('string');
      expect(p.primary.length).toBeGreaterThan(0);
      expect(Array.isArray(p.fallbacks)).toBe(true);
      expect(['ask', 'auto', 'never']).toContain(p.downgrade);
    }
    // verify must use the independent family (qwen, not llama)
    const verify = policies.find((p) => p.taskClass === 'verify')!;
    expect(verify.primary).toMatch(/qwen/i);
  });

  it('routing recent reports honestly when the daemon is unavailable', async () => {
    const recent = await getRoutingRecent();
    // No daemon running in tests → available must be false with an honest note
    expect(recent.available).toBe(false);
    expect(recent.entries).toEqual([]);
    expect(recent.note).toMatch(/not exposed|policy table/i);
  }, 15000);
});

describe('F7 permissions (opsBackend)', () => {
  it('returns the real tier table + profile matrix + current profile', () => {
    const info = getPolicyInfo();
    expect(info.tiers).toEqual([
      'read-only',
      'edit-workspace',
      'run-tests',
      'install-deps',
      'network',
      'destructive',
    ]);
    expect(info.profiles).toEqual(['cautious', 'balanced', 'autopilot']);
    // cautious: edit-workspace must ask; destructive must deny everywhere
    expect(info.matrix.cautious['edit-workspace']).toBe('ask');
    expect(info.matrix.cautious['destructive']).toBe('deny');
    expect(info.matrix.balanced['destructive']).toBe('deny');
    expect(info.matrix.autopilot['destructive']).toBe('ask');
    expect(['cautious', 'balanced', 'autopilot']).toContain(info.currentProfile);
    expect(typeof info.profileSource).toBe('string');
  });
});

describe('F8 hooks consent (opsBackend)', () => {
  it('returns an array (empty when no consent store exists)', () => {
    const consents = getHooksConsent();
    expect(Array.isArray(consents)).toBe(true);
    for (const c of consents) {
      expect(typeof c.hash).toBe('string');
      expect(typeof c.workspaceRoot).toBe('string');
      expect(typeof c.consentedAt).toBe('string');
    }
  });
});

describe('F10 security (opsBackend)', () => {
  it('returns the real 13 injection rules', () => {
    const status = getSecurityStatus();
    expect(status.firewallRules.length).toBe(13);
    const ruleIds = status.firewallRules.map((r) => r.rule);
    for (const id of ['ignore-instructions', 'jailbreak-phrasing', 'exfil-env', 'destructive-shell', 'reverse-shell']) {
      expect(ruleIds).toContain(id);
    }
    for (const r of status.firewallRules) {
      expect(['block', 'ask']).toContain(r.severity);
      expect(typeof r.detail).toBe('string');
    }
  });

  it('returns the real taint-to-sink tier mapping', () => {
    const status = getSecurityStatus();
    const bySink = Object.fromEntries(status.sinkTiers.map((s) => [s.sink, s.tier]));
    expect(bySink.terminal).toBe('destructive');
    expect(bySink.network).toBe('network');
    expect(bySink.read).toBe('read-only');
  });

  it('describes secret-scan and MCP pins honestly (no fake results)', () => {
    const status = getSecurityStatus();
    expect(status.secretScan.available).toBe(true);
    expect(status.secretScan.note).toMatch(/live|automatically/i);
    expect(status.mcpPins.available).toBe(true);
    expect(status.mcpPins.note).toMatch(/SHA-256|re-approval/i);
  });
});

describe('F12 scoreboard (opsBackend)', () => {
  it('parses the real docs/SCOREBOARD.md', () => {
    const board = getScoreboard();
    expect(board.found).toBe(true);
    expect(Array.isArray(board.rows)).toBe(true);
    // The checked-in scoreboard has the fake-scripted baseline row
    expect(board.rows.length).toBeGreaterThan(0);
    for (const r of board.rows) {
      expect(typeof r.model).toBe('string');
      expect(typeof r.passRate).toBe('string');
      expect(typeof r.costPerSuccess).toBe('string');
    }
    expect(typeof board.note).toBe('string');
  });
});
