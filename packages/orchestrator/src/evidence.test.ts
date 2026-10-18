// @sunday/orchestrator — vitest for evidence.ts (F9 Evidence Pack).
// Pure/static: no check execution, no LLM — heuristics only.
import { describe, expect, it } from 'vitest';
import {
  classifyIntentRelation,
  collectEvidencePack,
  detectChecks,
  evidencePackSchema,
  parseDiff,
  rankHunks,
  scoreHunk,
  scoreToTier,
  summarizeEvidencePack,
  withVisualProof,
} from './evidence.js';

const SAMPLE_DIFF = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 1111111..2222222 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -10,7 +10,9 @@ export function createSession(user: User) {
   const token = sign(user.id);
-  return { token, expiresIn: 3600 };
+  // almost-right bug: expiry bypass when rememberMe is set
+  const expiresIn = user.rememberMe ? 365 * 24 * 3600 : 3600;
+  return { token, expiresIn };
 }
diff --git a/db/migrations/004_add_role.sql b/db/migrations/004_add_role.sql
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/db/migrations/004_add_role.sql
@@ -0,0 +1,3 @@
+ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
+CREATE INDEX idx_users_role ON users(role);
diff --git a/package.json b/package.json
index 4444444..5555555 100644
--- a/package.json
+++ b/package.json
@@ -1,5 +1,5 @@ export {};
-  "version": "1.0.0",
+  "version": "1.0.1",
diff --git a/src/ui/button.ts b/src/ui/button.ts
index 6666666..7777777 100644
--- a/src/ui/button.ts
+++ b/src/ui/button.ts
@@ -1,3 +1,3 @@ export function render() {
-  const x=1;
+  const x = 1;
 }
diff --git a/src/utils/format.ts b/src/utils/format.ts
index 8888888..9999999 100644
--- a/src/utils/format.ts
+++ b/src/utils/format.ts
@@ -1,4 +1,6 @@ export function fmt(n: number) {
-  return String(n);
+  // unrelated drive-by: changes number formatting globally
+  return n.toLocaleString('en-US');
 }
`;

describe('parseDiff', () => {
  it('extracts one hunk per @@ block with correct files', () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    expect(hunks).toHaveLength(5);
    expect(hunks.map((h) => h.file)).toEqual([
      'src/auth/session.ts',
      'db/migrations/004_add_role.sql',
      'package.json',
      'src/ui/button.ts',
      'src/utils/format.ts',
    ]);
  });

  it('marks new files and formatting-only hunks', () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    expect(hunks[1]!.isNewFile).toBe(true);
    expect(hunks[3]!.formattingOnly).toBe(true);
    expect(hunks[0]!.formattingOnly).toBe(false);
  });

  it('returns [] for empty diff without throwing', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('scoreHunk / scoreToTier', () => {
  it('tiers map to score bands', () => {
    expect(scoreToTier(90)).toBe('critical');
    expect(scoreToTier(70)).toBe('high');
    expect(scoreToTier(40)).toBe('medium');
    expect(scoreToTier(10)).toBe('low');
  });

  it('auth code change scores high with auth reason', () => {
    const [hunk] = parseDiff(SAMPLE_DIFF);
    const r = scoreHunk(hunk!);
    expect(['high', 'critical']).toContain(r.tier);
    expect(r.reasons.join(' ')).toMatch(/auth/i);
  });

  it('migration scores medium-or-higher', () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    const r = scoreHunk(hunks[1]!);
    expect(['medium', 'high', 'critical']).toContain(r.tier);
  });

  it('dependency manifest scores at least medium', () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    const r = scoreHunk(hunks[2]!);
    expect(r.score).toBeGreaterThanOrEqual(25);
  });

  it('formatting-only change is always low', () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    const r = scoreHunk(hunks[3]!);
    expect(r.tier).toBe('low');
    expect(r.reasons.join(' ')).toMatch(/formatting/i);
  });
});

describe('rankHunks', () => {
  it('puts high-risk hunks above low-risk noise', () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    const ranked = rankHunks(hunks);
    // seeded "almost-right" auth bug must be in the top 3 (acceptance gate)
    const top3 = ranked.slice(0, 3).map((h) => h.file);
    expect(top3).toContain('src/auth/session.ts');
    // the two low-risk hunks (formatting-only + routine) must be at the bottom
    const bottom2 = ranked.slice(-2).map((h) => h.file).sort();
    expect(bottom2).toEqual(['src/ui/button.ts', 'src/utils/format.ts']);
    // and every hunk above them is medium or higher
    for (const h of ranked.slice(0, 3)) {
      expect(['medium', 'high', 'critical']).toContain(scoreHunk(h).tier);
    }
  });
});

describe('classifyIntentRelation', () => {
  const goal = 'fix session expiry so remember-me lasts a year';

  it('marks the auth hunk related', () => {
    const [hunk] = parseDiff(SAMPLE_DIFF);
    const c = classifyIntentRelation(goal, hunk!);
    expect(c.relation).toBe('related');
  });

  it('flags the unrelated formatting drive-by', () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    const c = classifyIntentRelation(goal, hunks[4]!);
    expect(c.relation).toBe('unrelated');
  });
});

describe('detectChecks', () => {
  it('detects npm test/lint/typecheck from package.json', () => {
    const checks = detectChecks('/home/hatch/workspace/sunday-product/packages/orchestrator');
    const kinds = checks.map((c) => c.kind);
    expect(kinds).toContain('test');
    expect(kinds).toContain('typecheck');
  });
});

describe('collectEvidencePack', () => {
  it('generates a valid pack in static mode without errors', async () => {
    const pack = await collectEvidencePack({
      taskId: 'task-1',
      goal: 'fix session expiry so remember-me lasts a year',
      diffText: SAMPLE_DIFF,
      workspaceRoot: '/tmp',
      skipExecution: true,
      unknowns: ['did not run the app end-to-end in a browser'],
    });
    expect(() => evidencePackSchema.parse(pack)).not.toThrow();
    expect(pack.hunks).toHaveLength(5);
    // riskiest first
    expect(pack.hunks[0]!.file).toBe('src/auth/session.ts');
    // unrelated hunk flagged + unchecked by default
    expect(pack.unrelatedFiles).toContain('src/utils/format.ts');
    const unrelated = pack.hunks.find((h) => h.file === 'src/utils/format.ts')!;
    expect(unrelated.defaultChecked).toBe(false);
    // static mode records the skip as an unknown
    expect(pack.unknowns.length).toBeGreaterThanOrEqual(2);
  });

  it('verdict is needs-review for high-risk hunks with no passing tests', async () => {
    const pack = await collectEvidencePack({
      taskId: 'task-2',
      goal: 'fix session expiry',
      diffText: SAMPLE_DIFF,
      workspaceRoot: '/tmp',
      skipExecution: true,
    });
    expect(pack.verdict).toBe('needs-review');
    expect(pack.verdictReasons.join(' ')).toMatch(/no passing test/i);
  });

  it('verdict is pass for a lone formatting change', async () => {
    const fmtOnly = parseDiff(SAMPLE_DIFF)
      .filter((h) => h.file === 'src/ui/button.ts')
      .map(() => SAMPLE_DIFF.split('diff --git ')[4])
      .join('');
    const diffText = 'diff --git ' + fmtOnly;
    const pack = await collectEvidencePack({
      taskId: 'task-3',
      goal: 'format the button file',
      diffText,
      workspaceRoot: '/tmp',
      skipExecution: true,
    });
    expect(pack.hunks).toHaveLength(1);
    expect(pack.hunks[0]!.riskTier).toBe('low');
    expect(pack.verdict).toBe('pass');
  });

  it('summarizeEvidencePack renders markdown without throwing', async () => {
    const pack = await collectEvidencePack({
      taskId: 'task-4',
      goal: 'fix session expiry',
      diffText: SAMPLE_DIFF,
      workspaceRoot: '/tmp',
      skipExecution: true,
    });
    const md = summarizeEvidencePack(pack);
    expect(md).toContain('## Evidence Pack');
    expect(md).toContain('src/auth/session.ts');
    expect(md).toContain('### Not verified');
  });

  it('never throws on garbage diff input', async () => {
    const pack = await collectEvidencePack({
      taskId: 'task-5',
      goal: 'do something',
      diffText: 'this is not a diff at all {{{',
      workspaceRoot: '/tmp',
      skipExecution: true,
    });
    expect(pack.hunks).toHaveLength(0);
    expect(pack.unknowns.length).toBeGreaterThan(0);
  });

  it('F11: withVisualProof attaches browser diff artifacts without mutating', async () => {
    const pack = await collectEvidencePack({
      taskId: 'task-6',
      goal: 'fix misaligned pay button',
      diffText: SAMPLE_DIFF,
      workspaceRoot: '/tmp',
      skipExecution: true,
    });
    expect(pack.visualProof).toMatchObject({ kind: 'none', paths: [] });
    const paths = ['/tmp/media/visual-diff-1.png', '/tmp/media/viewport-desktop-1440x900.png'];
    const proofed = withVisualProof(pack, paths);
    expect(proofed.visualProof).toMatchObject({ kind: 'screenshot', paths });
    expect(() => evidencePackSchema.parse(proofed)).not.toThrow();
    // input untouched
    expect(pack.visualProof).toMatchObject({ kind: 'none', paths: [] });
    const walkthrough = withVisualProof(pack, ['/tmp/media/walkthrough.webm'], 'walkthrough');
    expect(walkthrough.visualProof.kind).toBe('walkthrough');
  });
});
