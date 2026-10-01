import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestrationError } from './errors.js';
import { createOrchestrationHandlers } from './handlers.js';
import { registerOrchestrationMethods } from './host.js';
import { ORCHESTRATE_METHODS } from './schemas.js';
import { reconcileOrchestrationRuns, type FileOrchestrationStateStore } from './state.js';
import type { OrchestratorHost, OrchestrationMethodHandler } from './host.js';
import type { OrchestrationRunState } from './schemas.js';

/**
 * RPC-layer tests for the Parallel-Agents `orchestrate/*` control methods
 * (Worker 2). Worker 1's run control (runner.ts) is mocked — these tests pin
 * the RPC contract: method names, param/result shapes, and error codes.
 * (Runner internals — pool, merge detection, resolve, cancel — are covered
 * by parallel.test.ts.)
 */
vi.mock('./runner.js', () => ({
  cancelOrchestrationRun: vi.fn(),
  getOrchestrationRunState: vi.fn(),
  resolveRunConflicts: vi.fn(),
}));

import {
  cancelOrchestrationRun,
  getOrchestrationRunState,
  resolveRunConflicts,
} from './runner.js';

const host = {} as unknown as OrchestratorHost;

function table(): Record<string, OrchestrationMethodHandler> {
  return createOrchestrationHandlers(host) as Record<string, OrchestrationMethodHandler>;
}

function makeState(over: Partial<OrchestrationRunState> = {}): OrchestrationRunState {
  return {
    runId: 'run-1',
    goal: 'add dark mode',
    parallel: true,
    status: 'running',
    units: [
      { id: 'u1', title: 'Unit one', status: 'done', worktreePath: '/tmp/wt/u1', sha: 'abc123' },
      { id: 'u2', title: 'Unit two', status: 'verifying', worktreePath: '/tmp/wt/u2' },
      { id: 'u3', title: 'Unit three', status: 'queued' },
    ],
    conflicts: [],
    createdAt: '2026-10-01T20:00:00.000Z',
    updatedAt: '2026-10-01T20:01:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('orchestrate/* method table', () => {
  it('registers all six methods in one namespace (no new namespace)', () => {
    expect(Object.keys(table()).sort()).toEqual([
      'orchestrate/merge',
      'orchestrate/plan',
      'orchestrate/resolveConflict',
      'orchestrate/run',
      'orchestrate/status',
      'orchestrate/stop',
    ]);
  });

  it('registerOrchestrationMethods puts all six on the daemon', () => {
    const added = new Map<string, OrchestrationMethodHandler>();
    registerOrchestrationMethods({
      addMethod: (name, handler) => void added.set(name, handler),
      getOrchestratorHost: () => host,
    });
    expect([...added.keys()].sort()).toEqual([
      'orchestrate/merge',
      'orchestrate/plan',
      'orchestrate/resolveConflict',
      'orchestrate/run',
      'orchestrate/status',
      'orchestrate/stop',
    ]);
  });
});

describe('orchestrate/run params (parallel phase)', () => {
  const params = ORCHESTRATE_METHODS['orchestrate/run'].params;

  it('accepts parallel and maxParallel', () => {
    const p = params.safeParse({ goal: 'g', workspaceRoot: '/tmp/ws', parallel: true, maxParallel: 2 });
    expect(p.success).toBe(true);
    if (p.success) {
      expect(p.data.parallel).toBe(true);
      expect(p.data.maxParallel).toBe(2);
    }
  });

  it('rejects maxParallel 0', () => {
    expect(
      params.safeParse({ goal: 'g', workspaceRoot: '/tmp/ws', parallel: true, maxParallel: 0 }).success,
    ).toBe(false);
  });

  it('leaves parallel/maxParallel absent when not passed (runner defaults apply)', () => {
    const p = params.safeParse({ goal: 'g', workspaceRoot: '/tmp/ws' });
    expect(p.success).toBe(true);
    if (p.success) {
      expect(p.data.parallel).toBeUndefined();
      expect(p.data.maxParallel).toBeUndefined();
    }
  });
});

describe('orchestrate/stop', () => {
  it('cancels a running run and returns { stopped: true }', async () => {
    vi.mocked(cancelOrchestrationRun).mockResolvedValue({ stopped: true });
    const res = await table()['orchestrate/stop']({ runId: 'run-1' });
    expect(cancelOrchestrationRun).toHaveBeenCalledWith('run-1');
    expect(res).toEqual({ stopped: true });
  });

  it('returns { stopped: false } for an unknown or finished run (idempotent, no 404)', async () => {
    vi.mocked(cancelOrchestrationRun).mockResolvedValue({ stopped: false });
    const res = await table()['orchestrate/stop']({ runId: 'nope' });
    expect(res).toEqual({ stopped: false });
  });

  it('rejects invalid params', async () => {
    await expect(table()['orchestrate/stop']({})).rejects.toMatchObject({
      name: 'OrchestrationError',
      code: 'invalid-params',
    });
    expect(cancelOrchestrationRun).not.toHaveBeenCalled();
  });
});

describe('orchestrate/status', () => {
  it('returns the full run state with per-unit states', async () => {
    const state = makeState();
    vi.mocked(getOrchestrationRunState).mockReturnValue(state);
    const res = (await table()['orchestrate/status']({ runId: 'run-1' })) as OrchestrationRunState;
    expect(getOrchestrationRunState).toHaveBeenCalledWith('run-1');
    expect(res.runId).toBe('run-1');
    expect(res.status).toBe('running');
    expect(res.units.map((u) => [u.id, u.status])).toEqual([
      ['u1', 'done'],
      ['u2', 'verifying'],
      ['u3', 'queued'],
    ]);
  });

  it('throws unknown-run (404-style) for an unknown runId', async () => {
    vi.mocked(getOrchestrationRunState).mockReturnValue(undefined);
    const err = (await table()['orchestrate/status']({ runId: 'nope' }).catch((e) => e)) as OrchestrationError;
    expect(err).toBeInstanceOf(OrchestrationError);
    expect(err.code).toBe('unknown-run');
  });

  it('rejects invalid params', async () => {
    await expect(table()['orchestrate/status']({ runId: '' })).rejects.toMatchObject({
      code: 'invalid-params',
    });
  });
});

describe('orchestrate/merge', () => {
  it('reports conflicts and merged units from the run state', async () => {
    const state = makeState({
      status: 'conflicted',
      conflicts: [
        {
          index: 0,
          file: 'src/a.ts',
          hunks: [
            { file: 'src/a.ts', unitA: 'u1', unitB: 'u2', rangeA: [1, 5], rangeB: [1, 5] },
          ],
        },
      ],
    });
    vi.mocked(getOrchestrationRunState).mockReturnValue(state);
    const res = await table()['orchestrate/merge']({ runId: 'run-1' });
    expect(res).toEqual({ conflicts: state.conflicts, merged: ['u1'] });
  });

  it('returns an empty conflict list for a cleanly merged run', async () => {
    const state = makeState({
      status: 'done',
      units: [
        { id: 'u1', title: 'Unit one', status: 'done', worktreePath: '/tmp/wt/u1', sha: 'abc123' },
        { id: 'u2', title: 'Unit two', status: 'done', worktreePath: '/tmp/wt/u2', sha: 'def456' },
      ],
    });
    vi.mocked(getOrchestrationRunState).mockReturnValue(state);
    const res = await table()['orchestrate/merge']({ runId: 'run-1' });
    expect(res).toEqual({ conflicts: [], merged: ['u1', 'u2'] });
  });

  it('throws unknown-run for an unknown runId', async () => {
    vi.mocked(getOrchestrationRunState).mockReturnValue(undefined);
    await expect(table()['orchestrate/merge']({ runId: 'nope' })).rejects.toMatchObject({
      code: 'unknown-run',
    });
  });
});

describe('orchestrate/resolveConflict', () => {
  it('applies resolutions via resolveRunConflicts and returns the updated outcome', async () => {
    const updated = makeState({
      status: 'done',
      conflicts: [],
      units: [
        { id: 'u1', title: 'Unit one', status: 'done', worktreePath: '/tmp/wt/u1', sha: 'abc123' },
        { id: 'u2', title: 'Unit two', status: 'done', worktreePath: '/tmp/wt/u2', sha: 'def456' },
      ],
    });
    vi.mocked(resolveRunConflicts).mockResolvedValue(undefined);
    vi.mocked(getOrchestrationRunState).mockReturnValue(updated);
    const resolutions = [{ conflictIndex: 0, keepUnitId: 'u1' }];
    const res = await table()['orchestrate/resolveConflict']({ runId: 'run-1', resolutions });
    expect(resolveRunConflicts).toHaveBeenCalledWith('run-1', resolutions);
    expect(res).toEqual({ conflicts: [], merged: ['u1', 'u2'] });
  });

  it('rejects an empty resolutions array (schema requires at least one)', async () => {
    await expect(
      table()['orchestrate/resolveConflict']({ runId: 'run-1', resolutions: [] }),
    ).rejects.toMatchObject({ code: 'invalid-params' });
    expect(resolveRunConflicts).not.toHaveBeenCalled();
  });

  it('rejects a resolution missing keepUnitId', async () => {
    await expect(
      table()['orchestrate/resolveConflict']({ runId: 'run-1', resolutions: [{ conflictIndex: 0 }] }),
    ).rejects.toMatchObject({ code: 'invalid-params' });
    expect(resolveRunConflicts).not.toHaveBeenCalled();
  });

  it('propagates Worker 1 errors (e.g. unknown-run when the originating process is gone)', async () => {
    vi.mocked(resolveRunConflicts).mockRejectedValue(
      new OrchestrationError('unknown-run', 'no suspended (conflicted) run: run-1'),
    );
    const resolutions = [{ conflictIndex: 0, keepUnitId: 'u1' }];
    await expect(
      table()['orchestrate/resolveConflict']({ runId: 'run-1', resolutions }),
    ).rejects.toMatchObject({ code: 'unknown-run' });
  });
});

/** Fake FileOrchestrationStateStore: in-memory, no home-dir touching. */
class FakeStore {
  runs = new Map<string, OrchestrationRunState>();
  async init(): Promise<void> {}
  async save(state: OrchestrationRunState): Promise<void> {
    this.runs.set(state.runId, JSON.parse(JSON.stringify(state)) as OrchestrationRunState);
  }
  async load(runId: string): Promise<OrchestrationRunState | undefined> {
    return this.runs.get(runId);
  }
  async list(): Promise<OrchestrationRunState[]> {
    return [...this.runs.values()];
  }
  async remove(runId: string): Promise<void> {
    this.runs.delete(runId);
  }
}

describe('reconcileOrchestrationRuns (real, fake store)', () => {
  it('marks stale non-terminal runs interrupted, leaves the rest alone', async () => {
    const store = new FakeStore();
    store.runs.set('stale', makeState({ runId: 'stale', status: 'running' }));
    store.runs.set('conf', makeState({ runId: 'conf', status: 'conflicted' }));
    store.runs.set('done', makeState({ runId: 'done', status: 'done' }));
    const cleaned: string[] = [];
    await reconcileOrchestrationRuns(
      store as unknown as FileOrchestrationStateStore,
      async (unit) => void cleaned.push(unit.id),
    );
    expect(store.runs.get('stale')?.status).toBe('interrupted');
    expect(store.runs.get('conf')?.status).toBe('conflicted');
    expect(store.runs.get('done')?.status).toBe('done');
    // Best-effort worktree cleanup ran for the stale run's units that have one.
    expect(cleaned.sort()).toEqual(['u1', 'u2']);
  });

  it('survives cleanup failures (best-effort)', async () => {
    const store = new FakeStore();
    store.runs.set('stale', makeState({ runId: 'stale', status: 'running' }));
    await reconcileOrchestrationRuns(
      store as unknown as FileOrchestrationStateStore,
      async () => {
        throw new Error('cleanup boom');
      },
    );
    expect(store.runs.get('stale')?.status).toBe('interrupted');
  });
});
