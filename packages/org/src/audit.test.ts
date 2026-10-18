import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from './audit.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'org-audit-'));
});

describe('AuditLog', () => {
  it('records approvals and they appear in export', () => {
    const log = new AuditLog({ dir });
    const ev = log.recordApproval({
      actor: 'alice@acme.com',
      orgId: 'acme',
      summary: 'approved run_terminal(npm test)',
      details: { tool: 'run_terminal', decision: 'allow' },
    });
    expect(ev.id).toMatch(/^ae-/);
    expect(ev.type).toBe('approval');

    const exported = log.exportParsed();
    expect(exported).toHaveLength(1);
    expect(exported[0].summary).toBe('approved run_terminal(npm test)');
    expect(exported[0].actor).toBe('alice@acme.com');
  });

  it('records budget breaches', () => {
    const log = new AuditLog({ dir });
    log.recordBudgetBreach({
      actor: 'session-123',
      orgId: 'acme',
      summary: 'hard budget hit on scope day (100/100)',
      details: { scope: 'day', spent: 100, limit: 100, kind: 'hard-pause' },
    });
    const exported = log.exportParsed({ type: 'budget-breach' });
    expect(exported).toHaveLength(1);
    expect(exported[0].details).toMatchObject({ scope: 'day', kind: 'hard-pause' });
  });

  it('export type filter excludes other types', () => {
    const log = new AuditLog({ dir });
    log.recordApproval({ actor: 'a', summary: 'ok' });
    log.recordBudgetBreach({ actor: 'a', summary: 'breach' });
    expect(log.exportParsed({ type: 'approval' })).toHaveLength(1);
    expect(log.exportParsed({ type: 'budget-breach' })).toHaveLength(1);
    expect(log.exportParsed()).toHaveLength(2);
  });

  it('export returns valid JSONL', () => {
    const log = new AuditLog({ dir });
    log.recordPolicyDecision({ actor: 'system', summary: 'deny: destructive tier' });
    const raw = log.export();
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { type: string };
    expect(parsed.type).toBe('policy-decision');
  });

  it('empty log exports empty string', () => {
    const log = new AuditLog({ dir });
    expect(log.export()).toBe('');
  });

  it('events are append-only across instances', () => {
    const a = new AuditLog({ dir });
    a.recordApproval({ actor: 'a', summary: 'first' });
    const b = new AuditLog({ dir });
    b.recordApproval({ actor: 'b', summary: 'second' });
    expect(b.exportParsed()).toHaveLength(2);
  });

  it('records org-policy lock enforcement events', () => {
    const log = new AuditLog({ dir });
    log.record({
      type: 'org-policy',
      actor: 'system',
      orgId: 'acme',
      summary: 'locked setting policy.profile kept at cautious (user autopilot ignored)',
      details: { key: 'policy.profile', orgValue: 'cautious', attempted: 'autopilot' },
    });
    const exported = log.exportParsed({ type: 'org-policy' });
    expect(exported).toHaveLength(1);
    expect(exported[0].details).toMatchObject({ key: 'policy.profile' });
  });
});
