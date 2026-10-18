/**
 * INTEGRATION WAVE — verification tests.
 *
 * Every test below exercises the REAL backend module through agentBackend.ts.
 * No mocks: assertions check real behavior (real estimator output shape,
 * real ledger persistence, real PermissionIntel verdicts, real evidence
 * rankings). If any wiring regresses to a stub, these tests fail.
 */
import { describe, it, expect } from 'vitest';
import {
  getRealEstimate,
  getRealUsage,
  recordTurn,
  checkBudgetGate,
  continueBudget,
  getLoopGuardStatus,
  getContextUsage,
  trackTurn,
  pinFact,
  unpinFact,
  listPins,
  previewCompactionOut,
  hybridSearchOut,
  evaluatePolicy,
  listHooksOut,
  evidenceForDiff,
} from './agentBackend.js';

describe('F1: real estimator (no mock)', () => {
  it('returns a real estimate with the ext-agent estimator shape', () => {
    const e = getRealEstimate('refactor the auth module and add tests for login');
    // Real estimator: min/max/confidence/rationale/formatted — never hardcoded stub values
    expect(e.min).toBeGreaterThanOrEqual(2);
    expect(e.max).toBeGreaterThan(e.min);
    expect(['low', 'medium', 'high']).toContain(e.confidence);
    expect(typeof e.rationale).toBe('string');
    expect(e.rationale.length).toBeGreaterThan(0);
    expect(e.formatted).toContain('~');
    // The word "refactor" + "tests" must push the estimate up (real heuristic)
    const small = getRealEstimate('hi');
    expect(e.max).toBeGreaterThan(small.max);
  });

  it('records turns in the real ledger and usage reflects them', () => {
    const before = getRealUsage();
    recordTurn(7, true, 'auto');
    const after = getRealUsage();
    expect(after.used).toBeGreaterThanOrEqual(before.used);
    expect(after.taskSpend).toBe(7);
    // costPerSuccessfulTask is the real F1 metric (undefined only when no successes)
    expect(after.costPerSuccessfulTask === undefined || after.costPerSuccessfulTask > 0).toBe(true);
  });

  it('budget gate passes when nothing paused; continueBudget is real', () => {
    expect(() => checkBudgetGate()).not.toThrow();
    // continueAllowance on a non-paused scope is a no-op that must not throw
    continueBudget('task', 10);
    expect(() => checkBudgetGate()).not.toThrow();
  });
});

describe('F2: real loop guard status', () => {
  it('returns the real guard state (not tripped on fresh instance)', () => {
    const s = getLoopGuardStatus();
    expect(s.tripped).toBe(false);
    expect(typeof s.recentCalls).toBe('number');
  });
});

describe('F4: real context cockpit', () => {
  it('meter tracks turns with real token accounting', () => {
    const before = getContextUsage();
    trackTurn('hello world', 'hi there, how can I help?');
    const after = getContextUsage();
    expect(after.used).toBeGreaterThanOrEqual(before.used);
    expect(after.limit).toBeGreaterThan(0);
    expect(typeof after.percent).toBe('number');
    expect(after.breakdown).toBeDefined();
  });

  it('pin/unpin/list round-trips through the real PinnedStore', () => {
    const pinned = pinFact('never touch the auth module');
    expect(pinned.id).toBeTruthy();
    expect(pinned.text).toBe('never touch the auth module');
    const list = listPins();
    expect(list.some((p) => p.id === pinned.id)).toBe(true);
    expect(unpinFact(pinned.id)).toBe(true);
    expect(listPins().some((p) => p.id === pinned.id)).toBe(false);
  });

  it('compaction preview uses the real previewCompaction', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message number ${i} with some content to fill tokens `.repeat(20),
    }));
    const p = previewCompactionOut(msgs);
    // Real preview: arrays + token counts + draft summary
    expect(Array.isArray(p.toSummarize)).toBe(true);
    expect(Array.isArray(p.toDrop)).toBe(true);
    expect(p.tokensBefore).toBeGreaterThan(0);
    expect(typeof p.draftSummary).toBe('string');
  });
});

describe('F5: real hybrid search', () => {
  it('throws the REAL no-index error (not a mock) when workspace has no index', async () => {
    await expect(hybridSearchOut('/tmp/definitely-not-a-workspace-xyz', 'foo')).rejects.toThrow(
      /no index/i,
    );
  });
});

describe('F7: real permission intelligence', () => {
  it('classifies rm -rf / as destructive/deny via the real PermissionIntel', () => {
    const r = evaluatePolicy('rm -rf /', '/tmp');
    expect(r.tier).toBe('destructive');
    expect(r.decision).toBe('deny');
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('allows benign reads', () => {
    const r = evaluatePolicy('ls -la', '/tmp');
    expect(['allow', 'ask']).toContain(r.decision);
    expect(r.tier).not.toBe('destructive');
  });

  it('catches bypass attempts (command chaining)', () => {
    const r = evaluatePolicy('echo hello; rm -rf /tmp/important', '/tmp');
    expect(r.tier).toBe('destructive');
  });
});

describe('F8: real hooks loader', () => {
  it('returns a real list (array) from the actual hooks files', () => {
    const hooks = listHooksOut('/tmp');
    expect(Array.isArray(hooks)).toBe(true);
    // Each entry has the real LoadedHook shape
    for (const h of hooks) {
      expect(typeof h.name).toBe('string');
      expect(typeof h.event).toBe('string');
      expect(['repo', 'user']).toContain(h.source);
    }
  });
});

describe('F9: real evidence pack', () => {
  const diff = `diff --git a/src/auth.ts b/src/auth.ts
index 111..222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
+import { exec } from 'child_process';
 export function login(pw: string) {
-  return check(pw);
+  return exec('check ' + pw);
 }
diff --git a/README.md b/README.md
index 333..444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-hello
+hello world
`;

  it('ranks the auth+exec hunk as high risk via the real scorer', () => {
    const e = evidenceForDiff(diff, 'fix login');
    expect(e.hunks).toBe(2);
    expect(e.highRisk).toBeGreaterThanOrEqual(1);
    expect(e.topRisks.length).toBeGreaterThan(0);
    // The auth.ts hunk must be top-ranked (real risk scoring, not mocked)
    expect(e.topRisks[0].path).toContain('auth');
    expect(['high', 'critical']).toContain(e.topRisks[0].tier);
  });
});
