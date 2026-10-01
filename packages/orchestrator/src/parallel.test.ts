/**
 * @sunday/orchestrator — parallel-mode tests with a mock OrchestratorHost.
 * No real models, no real git: runSubAgent is scripted per unit, dispatch
 * handles the worktree/checkpoint primitives against temp dirs, and git_diff
 * serves canned (or content-derived) diffs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@sunday/tools';
import type { ChatEvent } from '@sunday/protocol';
import {
  cancelOrchestrationRun,
  getOrchestrationRunState,
  listOrchestrationRuns,
  resolveRunConflicts,
  runOrchestration,
  FileOrchestrationStateStore,
} from './runner.js';
import type { OrchestratorHost, SubAgentRunOptions } from './host.js';
import type { OrchestrationEvent, PlannedUnit } from './schemas.js';
import { OrchestrationError } from './errors.js';
import { findMergeConflicts, parseDiffHunks } from './merge.js';

function unit(id: string, owns: string[]): PlannedUnit {
  return {
    id,
    title: `unit ${id}`,
    owns_paths: owns,
    acceptance: ['it works'],
    budget: 5,
  };
}

interface UnitBehavior {
  featureDelayMs?: number;
  verifierDelayMs?: number;
  /** Verdict per verifier attempt (attempt index; last repeats). Default: pass. */
  verdicts?: Array<'pass' | 'fail'>;
  /** Canned diff, or derived from the worktree at call time. */
  diff?: string | ((worktreePath: string) => string);
  /** Files the fake feature agent "writes" into its worktree. */
  writeFiles?: Record<string, string>;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface MockHost {
  host: OrchestratorHost;
  events: OrchestrationEvent[];
  dispatches: Array<{ method: string; params: unknown }>;
  titles: string[];
  tmpRoot: string;
  maxActive: () => number;
}

function createMockHost(behaviors: Record<string, UnitBehavior> = {}, defaultDiff = '(no diff)'): MockHost {
  const events: OrchestrationEvent[] = [];
  const dispatches: Array<{ method: string; params: unknown }> = [];
  const titles: string[] = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sun-par-'));
  const cwdToUnit = new Map<string, string>();
  let active = 0;
  let peak = 0;
  const verdictCounts = new Map<string, number>();

  const tools = new ToolRegistry();
  tools.register({
    definition: {
      name: 'git_diff',
      description: 'fake git diff',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    async execute(_args, ctx) {
      const unitId = cwdToUnit.get(ctx.cwd);
      const d = (unitId && behaviors[unitId]?.diff) ?? defaultDiff;
      return { output: typeof d === 'function' ? d(ctx.cwd) : d };
    },
  });

  const host: OrchestratorHost = {
    router: {} as OrchestratorHost['router'],
    tools,
    defaultModel: 'test-model',
    async dispatch(method: string, params: unknown): Promise<unknown> {
      dispatches.push({ method, params });
      const p = params as Record<string, string>;
      if (method === 'worktree/add') {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'wt-'));
        const unitId = String(p['branch']).split('/').pop() ?? 'unknown';
        cwdToUnit.set(dir, unitId);
        return { path: dir, branch: p['branch'] };
      }
      if (method === 'worktree/merge') return { merged: true, sha: `sha-${p['path']}`, target: 'main' };
      if (method === 'worktree/remove') return { removed: true };
      if (method === 'checkpoint/create') {
        return { id: 'cp-1', sha: 'abc', createdAt: new Date().toISOString() };
      }
      throw new Error(`unexpected dispatch: ${method}`);
    },
    notify(event: OrchestrationEvent): void {
      events.push(event);
    },
    async runSubAgent(o: SubAgentRunOptions): Promise<void> {
      titles.push(o.title);
      if (o.signal?.aborted) throw new Error('aborted');
      active += 1;
      peak = Math.max(peak, active);
      try {
        const isVerifier = o.title.startsWith('SUNDAY verifier:');
        const unitId = isVerifier
          ? o.title.slice('SUNDAY verifier: '.length)
          : o.title.split(' ')[2];
        const b = behaviors[unitId];
        const delay = isVerifier ? (b?.verifierDelayMs ?? 0) : (b?.featureDelayMs ?? 0);
        if (delay > 0) await sleepAbortable(delay, o.signal);
        if (o.signal?.aborted) throw new Error('aborted');
        if (!isVerifier && b?.writeFiles) {
          for (const [rel, content] of Object.entries(b.writeFiles)) {
            const abs = path.join(o.cwd, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
          }
        }
        if (isVerifier) {
          const n = verdictCounts.get(unitId) ?? 0;
          verdictCounts.set(unitId, n + 1);
          const vs = b?.verdicts ?? ['pass'];
          const verdict = vs[Math.min(n, vs.length - 1)];
          o.onEvent({
            type: 'text-delta',
            delta: JSON.stringify({
              verdict,
              evidence: verdict === 'pass' ? 'all criteria met' : 'criterion failed',
              failing_criterion: verdict === 'fail' ? 'it works' : undefined,
            }),
          } as ChatEvent);
        }
        o.onEvent({ type: 'turn-end', finishReason: 'stop' } as ChatEvent);
      } finally {
        active -= 1;
      }
    },
  };
  return { host, events, dispatches, titles, tmpRoot, maxActive: () => peak };
}

function tempStore(): FileOrchestrationStateStore {
  return new FileOrchestrationStateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sun-store-')));
}

const GOAL = 'build the thing';
const ROOT = '/tmp/sun-test-workspace';

describe('parallel overlap gate', () => {
  it('refuses overlapping plans before ANY dispatch', async () => {
    const m = createMockHost();
    const plan = { units: [unit('u1', ['src/a/**']), unit('u2', ['src/a/**'])] };
    const err = await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      store: tempStore(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OrchestrationError);
    expect((err as OrchestrationError).code).toBe('plan-overlap');
    expect(m.dispatches).toHaveLength(0);
    expect(m.events).toHaveLength(0);
  });
});

describe('parallel execution', () => {
  it('runs 3 units concurrently (total time < sequential sum)', async () => {
    const m = createMockHost({
      u1: { featureDelayMs: 300 },
      u2: { featureDelayMs: 300 },
      u3: { featureDelayMs: 300 },
    });
    const plan = {
      units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**']), unit('u3', ['src/c/**'])],
    };
    const start = Date.now();
    const result = await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      store: tempStore(),
    });
    const elapsed = Date.now() - start;
    // Sequential would take ~900ms of feature-agent time; parallel ~300ms.
    expect(elapsed).toBeLessThan(750);
    expect(m.maxActive()).toBe(3);
    expect(result.units.map((u) => `${u.id}:${u.status}`)).toEqual([
      'u1:merged',
      'u2:merged',
      'u3:merged',
    ]);
    expect(result.mergedSha).toMatch(/^sha-/);
    const merges = m.dispatches.filter((d) => d.method === 'worktree/merge');
    expect(merges).toHaveLength(3);
    // Merge is a write op: every per-unit merge event carries the merge-write tag.
    const mergedEvents = m.events.filter((e) => e.phase === 'merged' && e.unitId !== '');
    expect(mergedEvents).toHaveLength(3);
    for (const e of mergedEvents) expect(e.detail).toContain('merge-write');
    // Final verification runs exactly once over the merged result.
    expect(m.titles.filter((t) => t === 'SUNDAY verifier: merged-result')).toHaveLength(1);
    const runId = m.events[0].runId;
    expect(getOrchestrationRunState(runId)?.status).toBe('done');
  });

  it('emits queued for units waiting on a pool slot and caps concurrency', async () => {
    const m = createMockHost({
      u1: { featureDelayMs: 200 },
      u2: { featureDelayMs: 200 },
      u3: { featureDelayMs: 200 },
    });
    const plan = {
      units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**']), unit('u3', ['src/c/**'])],
    };
    const result = await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      maxParallel: 2,
      store: tempStore(),
    });
    expect(result.units.every((u) => u.status === 'merged')).toBe(true);
    expect(m.maxActive()).toBeLessThanOrEqual(2);
    const queued = m.events.filter((e) => e.phase === 'queued');
    expect(queued.map((e) => e.unitId)).toEqual(['u3']);
  });

  it("one unit's failure never kills the others", async () => {
    const m = createMockHost({
      u1: {},
      u2: { verdicts: ['fail', 'fail', 'fail'] },
      u3: {},
    });
    const plan = {
      units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**']), unit('u3', ['src/c/**'])],
    };
    const result = await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      store: tempStore(),
    });
    expect(result.units.map((u) => `${u.id}:${u.status}`)).toEqual([
      'u1:merged',
      'u2:failed',
      'u3:merged',
    ]);
    expect(m.dispatches.filter((d) => d.method === 'worktree/merge')).toHaveLength(2);
    // The failed unit's worktree is cleaned up; the run still verifies + completes.
    expect(getOrchestrationRunState(m.events[0].runId)?.status).toBe('done');
  });

  it('a failed final verification marks the run failed (no re-delegation)', async () => {
    const m = createMockHost(
      {
        u1: {},
        'merged-result': { verdicts: ['fail'] },
      },
      '(no diff)',
    );
    const plan = { units: [unit('u1', ['src/a/**'])] };
    const result = await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      store: tempStore(),
    });
    // The unit merged, but the merged result failed verification → run failed.
    expect(result.units).toEqual([{ id: 'u1', status: 'merged', sha: expect.any(String) }]);
    expect(getOrchestrationRunState(m.events[0].runId)?.status).toBe('failed');
    const failedEvents = m.events.filter((e) => e.phase === 'failed' && e.unitId === '');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].detail).toContain('final verification');
    // No re-delegation: exactly one verifier turn for the merged result.
    expect(m.titles.filter((t) => t === 'SUNDAY verifier: merged-result')).toHaveLength(1);
  });
});

describe('merge conflict detection', () => {
  const diffA = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,4 @@
 line10
 line11
 line12
+from-a`;
  const diffB = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -11,3 +11,4 @@
 line11
 line12
 line13
+from-b`;

  it('parseDiffHunks extracts files and ranges', () => {
    const hunks = parseDiffHunks(diffA);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].file).toBe('src/app.ts');
    expect(hunks[0].oldStart).toBe(10);
    expect(hunks[0].oldCount).toBe(3);
  });

  it('flags same-file overlapping hunks with different content', () => {
    const conflicts = findMergeConflicts([
      { unitId: 'u1', diff: diffA },
      { unitId: 'u2', diff: diffB },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].file).toBe('src/app.ts');
    expect(conflicts[0].hunks[0]).toMatchObject({ unitA: 'u1', unitB: 'u2' });
    expect(conflicts[0].hunks[0].rangeA).toEqual([10, 13]);
    expect(conflicts[0].hunks[0].rangeB).toEqual([11, 14]);
  });

  it('ignores identical hunks (duplicate changes merge cleanly)', () => {
    const conflicts = findMergeConflicts([
      { unitId: 'u1', diff: diffA },
      { unitId: 'u2', diff: diffA },
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it('ignores disjoint hunks in the same file', () => {
    const far = diffB.replaceAll('@@ -11,3 +11,4 @@', '@@ -100,3 +100,4 @@');
    expect(findMergeConflicts([{ unitId: 'u1', diff: diffA }, { unitId: 'u2', diff: far }])).toHaveLength(0);
  });

  it('flags two creations of the same new file', () => {
    const mk = (content: string) => `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+${content}`;
    expect(
      findMergeConflicts([
        { unitId: 'u1', diff: mk('aaa') },
        { unitId: 'u2', diff: mk('bbb') },
      ]),
    ).toHaveLength(1);
  });

  it('conflicted run: status, event, no merges, worktrees kept', async () => {
    const m = createMockHost({ u1: { diff: diffA }, u2: { diff: diffB } });
    const plan = { units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**'])] };
    const result = await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      store: tempStore(),
    });
    const runId = m.events[0].runId;
    const state = getOrchestrationRunState(runId);
    expect(state?.status).toBe('conflicted');
    expect(state?.conflicts).toHaveLength(1);
    expect(state?.conflicts[0].file).toBe('src/app.ts');
    // STOP: nothing merged.
    expect(m.dispatches.filter((d) => d.method === 'worktree/merge')).toHaveLength(0);
    const conflicted = m.events.filter((e) => e.phase === 'conflicted');
    expect(conflicted).toHaveLength(1);
    expect(() => JSON.parse(conflicted[0].detail ?? '')).not.toThrow();
    expect(result.units.map((u) => u.id)).toEqual(['u1', 'u2']);
    // Worktrees are kept on disk for resolution.
    expect(state?.units.every((u) => u.worktreePath)).toBe(true);
  });
});

describe('resolveRunConflicts', () => {
  const fileDiff = (content: string) => `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,1 @@
-base line
+${content}`;

  function conflictedRun(): Promise<{ m: MockHost; runId: string }> {
    const m = createMockHost({
      u1: {
        writeFiles: { 'src/app.ts': 'content-from-u1\n' },
        diff: (wt) => fileDiff(fs.readFileSync(path.join(wt, 'src/app.ts'), 'utf8').trim()),
      },
      u2: {
        writeFiles: { 'src/app.ts': 'content-from-u2\n' },
        diff: (wt) => fileDiff(fs.readFileSync(path.join(wt, 'src/app.ts'), 'utf8').trim()),
      },
    });
    const plan = { units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**'])] };
    return runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      store: tempStore(),
    }).then(() => ({ m, runId: m.events[0].runId }));
  }

  it('applies keepUnitId file content and completes the merge', async () => {
    const { m, runId } = await conflictedRun();
    expect(getOrchestrationRunState(runId)?.status).toBe('conflicted');

    await resolveRunConflicts(runId, [{ conflictIndex: 0, keepUnitId: 'u1' }]);

    const state = getOrchestrationRunState(runId);
    expect(state?.status).toBe('done');
    expect(state?.conflicts).toHaveLength(0);
    // u2's worktree file now carries u1's content.
    const u2wt = state?.units.find((u) => u.id === 'u2')?.worktreePath ?? '';
    expect(fs.readFileSync(path.join(u2wt, 'src/app.ts'), 'utf8')).toBe('content-from-u1\n');
    // Merge phase re-ran: both units merged, final verification passed.
    expect(m.dispatches.filter((d) => d.method === 'worktree/merge')).toHaveLength(2);
    expect(m.titles.filter((t) => t === 'SUNDAY verifier: merged-result')).toHaveLength(1);
  });

  it('rejects unknown conflict indexes and non-party keepUnitIds', async () => {
    const { runId } = await conflictedRun();
    await expect(resolveRunConflicts(runId, [{ conflictIndex: 99, keepUnitId: 'u1' }])).rejects.toBeInstanceOf(
      OrchestrationError,
    );
    await expect(
      resolveRunConflicts(runId, [{ conflictIndex: 0, keepUnitId: 'nope' }]),
    ).rejects.toBeInstanceOf(OrchestrationError);
    // Still conflicted after the rejected attempts.
    expect(getOrchestrationRunState(runId)?.status).toBe('conflicted');
  });

  it('rejects resolving a non-conflicted run', async () => {
    const { runId } = await conflictedRun();
    await resolveRunConflicts(runId, [{ conflictIndex: 0, keepUnitId: 'u1' }]);
    expect(getOrchestrationRunState(runId)?.status).toBe('done');
    // The run is no longer suspended/conflicted — resolving again is an error.
    await expect(
      resolveRunConflicts(runId, [{ conflictIndex: 0, keepUnitId: 'u1' }]),
    ).rejects.toBeInstanceOf(OrchestrationError);
  });
});

describe('cancelOrchestrationRun', () => {
  it('cancels in-flight units, cleans worktrees, marks cancelled', async () => {
    const m = createMockHost({
      u1: { featureDelayMs: 800 },
      u2: { featureDelayMs: 800 },
    });
    const plan = { units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**'])] };
    const store = tempStore();
    const runPromise = runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      maxParallel: 2,
      store,
    });
    // Wait until both units are in flight, then cancel.
    let runId = '';
    for (let i = 0; i < 200 && runId === ''; i++) {
      const started = m.events.filter((e) => e.phase === 'started');
      if (started.length === 2) runId = started[0].runId;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(runId).not.toBe('');
    expect(await cancelOrchestrationRun(runId)).toEqual({ stopped: true });

    const result = await runPromise;
    expect(result.units.map((u) => `${u.id}:${u.status}`)).toEqual(['u1:cancelled', 'u2:cancelled']);
    const state = getOrchestrationRunState(runId);
    expect(state?.status).toBe('cancelled');
    expect(state?.units.map((u) => u.status)).toEqual(['cancelled', 'cancelled']);
    // Best-effort worktree cleanup ran for the in-flight units.
    expect(m.dispatches.filter((d) => d.method === 'worktree/remove').length).toBeGreaterThanOrEqual(2);
    // Nothing merged after a cancel.
    expect(m.dispatches.filter((d) => d.method === 'worktree/merge')).toHaveLength(0);
    // Persisted state agrees.
    expect(await store.load(runId)).toMatchObject({ status: 'cancelled' });
  });

  it('returns stopped:false for unknown runs', async () => {
    expect(await cancelOrchestrationRun('no-such-run')).toEqual({ stopped: false });
  });

  it('can stop a sequential run mid-flight', async () => {
    const m = createMockHost({ u1: { featureDelayMs: 500 } });
    const runPromise = runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan: { units: [unit('u1', ['src/a/**'])] },
      store: tempStore(),
    });
    let runId = '';
    for (let i = 0; i < 200 && runId === ''; i++) {
      if (m.events.length > 0) runId = m.events[0].runId;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(await cancelOrchestrationRun(runId)).toEqual({ stopped: true });
    await runPromise;
  });
});

describe('sequential path unchanged', () => {
  it('runs units one at a time with merge+checkpoint per unit', async () => {
    const m = createMockHost({ u1: { featureDelayMs: 100 }, u2: { featureDelayMs: 100 } });
    const plan = { units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**'])] };
    const result = await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      store: tempStore(),
    });
    expect(m.maxActive()).toBe(1);
    expect(result.units.map((u) => `${u.id}:${u.status}`)).toEqual(['u1:merged', 'u2:merged']);
    expect(m.dispatches.filter((d) => d.method === 'worktree/merge')).toHaveLength(2);
    expect(m.dispatches.filter((d) => d.method === 'checkpoint/create')).toHaveLength(2);
    // No queued/conflicted phases in the sequential path.
    expect(m.events.some((e) => e.phase === 'queued' || e.phase === 'conflicted')).toBe(false);
    // Sequential merge events keep their exact pre-parallel detail shape.
    const mergedEvents = m.events.filter((e) => e.phase === 'merged' && e.unitId !== '');
    expect(mergedEvents).toHaveLength(2);
    for (const e of mergedEvents) expect(e.detail).toMatch(/^sha sha-.* → main$/);
  });
});

describe('listOrchestrationRuns', () => {
  it('sees live runs', async () => {
    const m = createMockHost({ u1: {} });
    await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan: { units: [unit('u1', ['src/a/**'])] },
      parallel: true,
      store: tempStore(),
    });
    const runId = m.events[0].runId;
    expect(listOrchestrationRuns().some((r) => r.runId === runId)).toBe(true);
  });
});
