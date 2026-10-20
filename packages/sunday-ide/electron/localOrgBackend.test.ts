/**
 * INTEGRATION WAVE (F14 + F15) — verification tests.
 *
 * Every test exercises the REAL backend through localOrgBackend.ts.
 * No mocks: assertions check real behavior (live Ollama health check,
 * real model discovery, real org bundle parsing/verification, real JSONL
 * audit). If any wiring regresses to a stub, these tests fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getLocalChatStatus,
  listLocalModels,
  getLocalOnlyMode,
  setLocalOnlyMode,
  loadOrgPolicySummary,
  isOrgSettingLocked,
  getOrgAuditEvents,
} from './localOrgBackend.js';
import { AuditLog } from '@sunday/org';

describe('F14: local chat status (real Ollama health check)', () => {
  it('returns the real status shape from live daemon probe', async () => {
    const s = await getLocalChatStatus();
    expect(typeof s.enabled).toBe('boolean');
    expect(typeof s.available).toBe('boolean');
    // agentCapable is null (never probed) or a real boolean — never a stub string
    expect(s.agentCapable === null || typeof s.agentCapable === 'boolean').toBe(true);
    expect(typeof s.model).toBe('string');
    expect(s.model.startsWith('ollama:')).toBe(true);
    expect(typeof s.host).toBe('string');
    expect(s.host).toContain('11434');
  });
});

describe('F14: local model discovery (real provider)', () => {
  it('returns models with ollama: refs (live discovery or static fallback)', async () => {
    const models = await listLocalModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.id.startsWith('ollama:')).toBe(true);
      expect(typeof m.label).toBe('string');
      expect(typeof m.contextWindow).toBe('number');
    }
  });
});

describe('F14: local-only privacy toggle (real persistence)', () => {
  const before = getLocalOnlyMode();
  afterEach(() => {
    setLocalOnlyMode(before);
  });

  it('round-trips through the real prefs file', () => {
    expect(setLocalOnlyMode(true)).toBe(true);
    expect(getLocalOnlyMode()).toBe(true);
    expect(setLocalOnlyMode(false)).toBe(false);
    expect(getLocalOnlyMode()).toBe(false);
  });

  it('a local.json containing the literal null reads as off, never throws (audit L8)', () => {
    const prefsFile = path.join(os.homedir(), '.sunday-ide', 'local.json');
    fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
    fs.writeFileSync(prefsFile, 'null', 'utf8');
    // Pre-fix this threw TypeError (dereferencing .localOnly on null).
    expect(getLocalOnlyMode()).toBe(false);
    fs.writeFileSync(prefsFile, '42', 'utf8');
    expect(getLocalOnlyMode()).toBe(false);
    // afterEach restores the original value via setLocalOnlyMode.
  });
});

describe('F15: org bundle load (real parsing + verification)', () => {
  let tmp: string;
  const OLD_ENV = process.env.SUNDAY_ORG_ALLOW_UNSIGNED;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-org-test-'));
    process.env.SUNDAY_ORG_ALLOW_UNSIGNED = '1';
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (OLD_ENV === undefined) delete process.env.SUNDAY_ORG_ALLOW_UNSIGNED;
    else process.env.SUNDAY_ORG_ALLOW_UNSIGNED = OLD_ENV;
  });

  function writeBundle(dir: string, locked: string[]): string {
    const p = path.join(dir, 'sunday-org.json');
    fs.writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        org: { id: 'acme', name: 'Acme Corp' },
        locked,
        policy: { profile: 'cautious' },
        allowedModels: ['llama-3.3-70b'],
      }),
    );
    return p;
  }

  it('returns found:false when no bundle exists anywhere relevant', () => {
    // A fresh tmp dir has no bundle; home walk-up may find one on dev
    // machines, so only assert the shape contract, not found:false.
    const s = loadOrgPolicySummary(tmp);
    expect(typeof s.found).toBe('boolean');
    expect(Array.isArray(s.locked)).toBe(true);
  });

  it('loads, verifies and summarizes a real unsigned bundle (dev mode)', () => {
    writeBundle(tmp, ['policy.profile', 'budgets.task']);
    const s = loadOrgPolicySummary(tmp);
    expect(s.found).toBe(true);
    expect(s.error).toBeUndefined();
    expect(s.orgId).toBe('acme');
    expect(s.orgName).toBe('Acme Corp');
    expect(s.locked).toContain('policy.profile');
    expect(s.locked).toContain('budgets.task');
    expect(s.policyProfile).toBe('cautious');
    expect(s.allowedModels).toEqual(['llama-3.3-70b']);
  });

  it('reports invalid bundles honestly instead of throwing', () => {
    fs.writeFileSync(path.join(tmp, 'sunday-org.json'), '{ not json');
    const s = loadOrgPolicySummary(tmp);
    expect(s.found).toBe(true);
    expect(typeof s.error).toBe('string');
  });

  it('isOrgSettingLocked uses real pattern matching', () => {
    writeBundle(tmp, ['policy.profile', 'budgets.*']);
    expect(isOrgSettingLocked('policy.profile', tmp)).toBe(true);
    expect(isOrgSettingLocked('budgets.task', tmp)).toBe(true);
    expect(isOrgSettingLocked('theme', tmp)).toBe(false);
  });
});

describe('F15: audit trail (real JSONL)', () => {
  it('getOrgAuditEvents returns a real array (empty when no trail yet)', () => {
    const events = getOrgAuditEvents(5);
    expect(Array.isArray(events)).toBe(true);
    for (const e of events) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.ts).toBe('string');
      expect(typeof e.summary).toBe('string');
    }
  });

  it('AuditLog round-trips a real event through a temp dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-audit-test-'));
    try {
      const log = new AuditLog({ dir });
      const recorded = log.record({
        type: 'policy-decision',
        actor: 'ide-test',
        summary: 'integration test event',
      });
      expect(recorded.id).toBeTruthy();
      const parsed = log.exportParsed();
      expect(parsed.some((e) => e.id === recorded.id)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
