/**
 * Mission Control — missionService tests.
 *
 * The daemon RPC is stubbed (expected for unit tests — shipped code has
 * no stubs); every assertion checks REAL missionService behavior:
 * persistence shape, honest error handling, caps, event binding, the
 * single-in-flight rule, and status mapping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMissionService, LOG_TAIL_CAP, type DaemonRpcFn } from './missionService.js';

const PLAN = {
  units: [
    { id: 'auth-fix', title: 'Fix auth', owns_paths: ['src/auth.ts'], acceptance: ['tests pass'], budget: 10 },
    { id: 'ui-polish', title: 'Polish UI', owns_paths: ['src/ui.tsx'], acceptance: ['renders'], budget: 5 },
  ],
  totalBudget: 17,
};

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-missions-'));
  filePath = path.join(tmpDir, '.sunday-ide', 'missions.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRpc(overrides: Partial<Record<string, (params: unknown) => unknown>> = {}): DaemonRpcFn {
  return async (method: string, params: unknown) => {
    const fn = overrides[method];
    if (fn) return fn(params);
    if (method === 'orchestrate/plan') return PLAN;
    if (method === 'orchestrate/run') {
      return { units: PLAN.units.map((u) => ({ id: u.id, status: 'merged', sha: 'abc123' })), mergedSha: 'abc123' };
    }
    if (method === 'orchestrate/status') {
      const runId = (params as { runId: string }).runId;
      return {
        runId,
        goal: 'g',
        parallel: false,
        status: 'done',
        units: PLAN.units.map((u) => ({ id: u.id, title: u.title, status: 'done', sha: 'abc123' })),
        conflicts: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    if (method === 'orchestrate/stop') return { stopped: true };
    throw new Error(`unexpected RPC ${method}`);
  };
}

async function waitFor(
  svc: ReturnType<typeof createMissionService>,
  id: string,
  pred: (status: string) => boolean,
  timeoutMs = 3000,
) {
  const start = Date.now();
  for (;;) {
    const list = await svc.listMissions();
    const m = list.find((x) => x.id === id);
    if (m && pred(m.status)) return m;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for mission ${id}; last=${m?.status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('missionService create/plan', () => {
  it('create → plan persisted with status planned + log entry', async () => {
    const svc = createMissionService({ rpc: makeRpc(), filePath });
    const m = await svc.createMission({ goal: 'fix auth and polish UI', workspaceRoot: '/tmp/ws', model: 'llama-3.3-70b' });
    expect(m.status).toBe('planned');
    expect(m.plan?.units).toHaveLength(2);
    expect(m.plan?.totalBudget).toBe(17);
    expect(m.model).toBe('llama-3.3-70b');
    expect(m.logTail).toHaveLength(1);
    expect(m.logTail[0].phase).toBe('planned');
    expect(m.logTail[0].detail).toContain('2 units');
    expect(m.logTail[0].detail).toContain('17');

    // Persisted on disk, newest first via list
    const list = await svc.listMissions();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(m.id);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { missions: unknown[] };
    expect(raw.missions).toHaveLength(1);
  });

  it('daemon plan failure → mission status error with real message, no fake units', async () => {
    const rpc = makeRpc({
      'orchestrate/plan': () => {
        throw new Error('daemon unavailable: connection refused');
      },
    });
    const svc = createMissionService({ rpc, filePath });
    const m = await svc.createMission({ goal: 'do stuff', workspaceRoot: '/tmp/ws' });
    expect(m.status).toBe('error');
    expect(m.error).toContain('daemon unavailable');
    expect(m.plan).toBeUndefined();
    expect(m.units).toBeUndefined();
    const list = await svc.listMissions();
    expect(list[0].status).toBe('error');
    expect(list[0].error).toContain('daemon unavailable');
  });
});

describe('missionService run lifecycle', () => {
  it('start → run resolves → done + units updated', async () => {
    const svc = createMissionService({ rpc: makeRpc(), filePath });
    const m = await svc.createMission({ goal: 'ship it', workspaceRoot: '/tmp/ws' });
    const queued = await svc.startMission(m.id);
    expect(['queued', 'running', 'done']).toContain(queued.status);
    const done = await waitFor(svc, m.id, (s) => s === 'done');
    expect(done.units).toHaveLength(2);
    expect(done.units?.every((u) => u.status === 'done')).toBe(true);
    expect(done.units?.[0].sha).toBe('abc123');
    expect(done.units?.[0].title).toBe('Fix auth');
  });

  it('run rejects → status error with message', async () => {
    const rpc = makeRpc({
      'orchestrate/run': () => {
        throw new Error('planner exploded');
      },
    });
    const svc = createMissionService({ rpc, filePath });
    const m = await svc.createMission({ goal: 'boom', workspaceRoot: '/tmp/ws' });
    await svc.startMission(m.id);
    const failed = await waitFor(svc, m.id, (s) => s === 'error');
    expect(failed.error).toContain('planner exploded');
  });

  it('run with a failed unit → mission failed', async () => {
    const rpc = makeRpc({
      'orchestrate/run': () => ({
        units: [
          { id: 'auth-fix', status: 'merged', sha: 'abc123' },
          { id: 'ui-polish', status: 'failed' },
        ],
      }),
    });
    const svc = createMissionService({ rpc, filePath });
    const m = await svc.createMission({ goal: 'partial', workspaceRoot: '/tmp/ws' });
    await svc.startMission(m.id);
    const failed = await waitFor(svc, m.id, (s) => s === 'failed');
    expect(failed.units?.find((u) => u.id === 'ui-polish')?.status).toBe('failed');
  });

  it('second start while one running → throws', async () => {
    let releaseRun: ((v: unknown) => void) | undefined;
    const rpc = makeRpc({
      'orchestrate/run': () =>
        new Promise((resolve) => {
          releaseRun = resolve;
        }),
    });
    const svc = createMissionService({ rpc, filePath });
    const a = await svc.createMission({ goal: 'first', workspaceRoot: '/tmp/ws' });
    const b = await svc.createMission({ goal: 'second', workspaceRoot: '/tmp/ws' });
    await svc.startMission(a.id);
    await expect(svc.startMission(b.id)).rejects.toThrow('another mission is already running');
    // Also re-starting the same in-flight mission throws the same honest error.
    await expect(svc.startMission(a.id)).rejects.toThrow('another mission is already running');
    releaseRun?.({ units: PLAN.units.map((u) => ({ id: u.id, status: 'merged' })) });
    await waitFor(svc, a.id, (s) => s === 'done');
  });
});

describe('missionService events', () => {
  it('event binding: first unknown runId binds to the single in-flight mission + log grows', async () => {
    let releaseRun: ((v: unknown) => void) | undefined;
    const rpc = makeRpc({
      'orchestrate/run': () =>
        new Promise((resolve) => {
          releaseRun = resolve;
        }),
    });
    const svc = createMissionService({ rpc, filePath });
    const m = await svc.createMission({ goal: 'bind me', workspaceRoot: '/tmp/ws' });
    await svc.startMission(m.id);

    svc.handleOrchestrateEvent({ runId: 'run-42', unitId: 'auth-fix', phase: 'started', detail: 'working' });
    let list = await svc.listMissions();
    let mine = list.find((x) => x.id === m.id)!;
    expect(mine.runId).toBe('run-42');
    expect(mine.status).toBe('running');
    expect(mine.logTail.some((e) => e.phase === 'started' && e.unitId === 'auth-fix')).toBe(true);
    expect(mine.units?.find((u) => u.id === 'auth-fix')?.status).toBe('running');

    // Second event matches by runId directly.
    svc.handleOrchestrateEvent({ runId: 'run-42', unitId: 'auth-fix', phase: 'verifying' });
    list = await svc.listMissions();
    mine = list.find((x) => x.id === m.id)!;
    expect(mine.units?.find((u) => u.id === 'auth-fix')?.status).toBe('verifying');

    releaseRun?.({ units: PLAN.units.map((u) => ({ id: u.id, status: 'merged' })) });
    await waitFor(svc, m.id, (s) => s === 'done');
  });

  it('events with unknown runId and no in-flight mission are dropped', async () => {
    const svc = createMissionService({ rpc: makeRpc(), filePath });
    const m = await svc.createMission({ goal: 'idle', workspaceRoot: '/tmp/ws' });
    svc.handleOrchestrateEvent({ runId: 'run-x', unitId: 'auth-fix', phase: 'started' });
    const list = await svc.listMissions();
    expect(list.find((x) => x.id === m.id)?.runId).toBeUndefined();
  });

  it('malformed events are ignored without throwing', async () => {
    const svc = createMissionService({ rpc: makeRpc(), filePath });
    expect(() => svc.handleOrchestrateEvent(null)).not.toThrow();
    expect(() => svc.handleOrchestrateEvent({})).not.toThrow();
    expect(() => svc.handleOrchestrateEvent({ runId: 5, phase: 'started' })).not.toThrow();
    expect(() => svc.handleOrchestrateEvent({ runId: 'r', phase: 'bogus' })).not.toThrow();
  });

  it('logTail cap: 205 events → length 200', async () => {
    let releaseRun: ((v: unknown) => void) | undefined;
    const rpc = makeRpc({
      'orchestrate/run': () =>
        new Promise((resolve) => {
          releaseRun = resolve;
        }),
    });
    const svc = createMissionService({ rpc, filePath });
    const m = await svc.createMission({ goal: 'noisy', workspaceRoot: '/tmp/ws' });
    await svc.startMission(m.id);
    // Bind first, then flood.
    svc.handleOrchestrateEvent({ runId: 'run-flood', unitId: 'auth-fix', phase: 'started', detail: 'e0' });
    for (let i = 1; i < 205; i++) {
      svc.handleOrchestrateEvent({ runId: 'run-flood', unitId: 'auth-fix', phase: 'started', detail: `e${i}` });
    }
    const list = await svc.listMissions();
    const mine = list.find((x) => x.id === m.id)!;
    expect(mine.logTail.length).toBe(LOG_TAIL_CAP);
    expect(mine.logTail.length).toBe(200);
    // Oldest dropped: the 'planned' + 'queued' + early flood entries are gone;
    // the newest entry survives.
    expect(mine.logTail[mine.logTail.length - 1].detail).toBe('e204');
    releaseRun?.({ units: [] });
  });
});

describe('missionService stop + refresh', () => {
  it('stop: calls orchestrate/stop and marks mission stopped (stop wins over run resolution)', async () => {
    let releaseRun: ((v: unknown) => void) | undefined;
    const stopCalls: unknown[] = [];
    const rpc = makeRpc({
      'orchestrate/run': () =>
        new Promise((resolve) => {
          releaseRun = resolve;
        }),
      'orchestrate/stop': (params) => {
        stopCalls.push(params);
        return { stopped: true };
      },
    });
    const svc = createMissionService({ rpc, filePath });
    const m = await svc.createMission({ goal: 'halt', workspaceRoot: '/tmp/ws' });
    await svc.startMission(m.id);
    svc.handleOrchestrateEvent({ runId: 'run-stop', unitId: 'auth-fix', phase: 'started' });
    const stopped = await svc.stopMission(m.id);
    expect(stopped.status).toBe('stopped');
    expect(stopCalls).toEqual([{ runId: 'run-stop' }]);
    // A late run resolution must not resurrect a stopped mission.
    releaseRun?.({ units: PLAN.units.map((u) => ({ id: u.id, status: 'merged' })) });
    await new Promise((r) => setTimeout(r, 30));
    const list = await svc.listMissions();
    expect(list.find((x) => x.id === m.id)?.status).toBe('stopped');
  });

  it('refresh: maps daemon status + units; conflicted → failed with merge-conflict error', async () => {
    let releaseRun: ((v: unknown) => void) | undefined;
    const svc = createMissionService({
      rpc: makeRpc({
        'orchestrate/run': () =>
          new Promise((resolve) => {
            releaseRun = resolve;
          }),
        'orchestrate/status': (params) => {
          const runId = (params as { runId: string }).runId;
          return {
            runId,
            goal: 'g',
            parallel: false,
            status: 'conflicted',
            units: [{ id: 'auth-fix', title: 'Fix auth', status: 'failed', error: 'conflict in src/auth.ts' }],
            conflicts: [{ index: 0, file: 'src/auth.ts', hunks: [] }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        },
      }),
      filePath,
    });
    const m = await svc.createMission({ goal: 'conflict', workspaceRoot: '/tmp/ws' });
    await svc.startMission(m.id);
    svc.handleOrchestrateEvent({ runId: 'run-conflict', unitId: 'auth-fix', phase: 'started' });
    const refreshed = await svc.refreshMission(m.id);
    expect(refreshed.status).toBe('failed');
    expect(refreshed.error).toContain('merge conflict');
    expect(refreshed.units?.[0].status).toBe('failed');
    releaseRun?.({ units: [] });
  });

  it('refresh without runId is a no-op returning the mission', async () => {
    const svc = createMissionService({ rpc: makeRpc(), filePath });
    const m = await svc.createMission({ goal: 'no run yet', workspaceRoot: '/tmp/ws' });
    const refreshed = await svc.refreshMission(m.id);
    expect(refreshed.id).toBe(m.id);
    expect(refreshed.status).toBe('planned');
  });
});

describe('missionService persistence robustness', () => {
  it('corrupt missions.json → empty list, never throws', async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ this is not json !!!', 'utf8');
    const svc = createMissionService({ rpc: makeRpc(), filePath });
    await expect(svc.listMissions()).resolves.toEqual([]);
    // And a wrong-shape JSON also yields empty.
    fs.writeFileSync(filePath, '{"nope": true}', 'utf8');
    await expect(svc.listMissions()).resolves.toEqual([]);
  });

  it('initMissionService registers the orchestrate/event handler exactly once', () => {
    const registered: { method: string; handler: unknown }[] = [];
    const svc = createMissionService({
      rpc: makeRpc(),
      filePath,
      addNotificationHandler: (method, handler) => {
        registered.push({ method, handler });
      },
    });
    svc.initMissionService();
    svc.initMissionService();
    expect(registered).toHaveLength(1);
    expect(registered[0].method).toBe('orchestrate/event');
    expect(typeof registered[0].handler).toBe('function');
  });
});
