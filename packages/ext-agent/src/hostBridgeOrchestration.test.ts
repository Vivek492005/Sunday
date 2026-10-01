// HostBridge orchestrate/* tests — typed facade over a stub RpcClient.
// Covers orchestrate/run (parallel flag passes through, long timeout),
// orchestrate/stop, orchestrate/status, orchestrate/resolveConflict, and
// orchestrate/event dispatch (valid events parsed, malformed dropped).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HostBridge } from './hostBridge.js';
import type { RpcClient } from './rpc.js';
import type { OrchestrationEvent } from '@sunday/protocol';

function makeRpc() {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const rpc = {
    request: vi.fn(async (_method: string, _params: unknown, _opts?: unknown) => ({})),
    onNotification: vi.fn((method: string, h: (p: unknown) => void) => {
      let set = handlers.get(method);
      if (!set) {
        set = new Set();
        handlers.set(method, set);
      }
      set.add(h);
      return () => {
        set!.delete(h);
      };
    }),
  };
  return { rpc: rpc as unknown as RpcClient, raw: rpc, handlers };
}

function emit(handlers: Map<string, Set<(p: unknown) => void>>, params: unknown) {
  for (const h of [...(handlers.get('orchestrate/event') ?? [])]) h(params);
}

const RUN_STATE = {
  runId: 'run-1',
  goal: 'goal',
  parallel: true,
  status: 'conflicted',
  units: [{ id: 'u-a', title: 'A', status: 'done', worktreePath: '/wt/a', model: 'm', steps: 3 }],
  conflicts: [
    {
      index: 0,
      file: 'f.ts',
      hunks: [{ file: 'f.ts', unitA: 'u-a', unitB: 'u-b', rangeA: [1, 2], rangeB: [3, 4] }],
    },
  ],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:01:00Z',
};

describe('HostBridge orchestrate/*', () => {
  let rpc: ReturnType<typeof makeRpc>;
  let bridge: HostBridge;

  beforeEach(() => {
    rpc = makeRpc();
    bridge = new HostBridge(rpc.rpc);
  });

  it('subscribes to orchestrate/event notifications', () => {
    expect(rpc.raw.onNotification).toHaveBeenCalledWith('orchestrate/event', expect.any(Function));
  });

  it('dispatches parsed orchestrate events to listeners', () => {
    const seen: OrchestrationEvent[] = [];
    const off = bridge.onOrchestrateEvent((n) => seen.push(n));
    emit(rpc.handlers, { runId: 'run-1', unitId: 'u-a', phase: 'started', detail: 'go' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ runId: 'run-1', unitId: 'u-a', phase: 'started' });
    off();
    emit(rpc.handlers, { runId: 'run-1', unitId: 'u-a', phase: 'merged' });
    expect(seen).toHaveLength(1);
  });

  it('drops malformed orchestrate events without crashing listeners', () => {
    const seen: OrchestrationEvent[] = [];
    bridge.onOrchestrateEvent((n) => seen.push(n));
    emit(rpc.handlers, { nope: true });
    emit(rpc.handlers, { runId: 'run-1', unitId: 'u-a', phase: 'bogus-phase' });
    expect(seen).toHaveLength(0);
  });

  it('dispose() unsubscribes orchestrate listeners', () => {
    const seen: OrchestrationEvent[] = [];
    bridge.onOrchestrateEvent((n) => seen.push(n));
    bridge.dispose();
    emit(rpc.handlers, { runId: 'run-1', unitId: 'u-a', phase: 'started' });
    expect(seen).toHaveLength(0);
  });

  it('orchestrateRun passes the parallel flag with a long timeout', async () => {
    rpc.raw.request.mockResolvedValueOnce({ units: [], mergedSha: 'abc' });
    const res = await bridge.orchestrateRun({
      goal: 'do things',
      workspaceRoot: '/w',
      parallel: true,
    });
    expect(rpc.raw.request).toHaveBeenCalledWith(
      'orchestrate/run',
      { goal: 'do things', workspaceRoot: '/w', parallel: true },
      { timeoutMs: 30 * 60 * 1000 },
    );
    expect(res.units).toEqual([]);
  });

  it('orchestrateStop calls orchestrate/stop with the runId', async () => {
    rpc.raw.request.mockResolvedValueOnce({ stopped: true });
    const res = await bridge.orchestrateStop('run-1');
    expect(rpc.raw.request).toHaveBeenCalledWith('orchestrate/stop', { runId: 'run-1' }, { timeoutMs: 15000 });
    expect(res.stopped).toBe(true);
  });

  it('orchestrateStatus validates the run state shape', async () => {
    rpc.raw.request.mockResolvedValueOnce(RUN_STATE);
    const state = await bridge.orchestrateStatus('run-1');
    expect(state.runId).toBe('run-1');
    expect(state.status).toBe('conflicted');
    expect(state.units[0].worktreePath).toBe('/wt/a');
    expect(state.conflicts[0].hunks[0].rangeA).toEqual([1, 2]);
  });

  it('orchestrateStatus rejects a wrong-shaped result', async () => {
    rpc.raw.request.mockResolvedValueOnce({ bogus: true });
    await expect(bridge.orchestrateStatus('run-1')).rejects.toThrow();
  });

  it('orchestrateResolveConflict sends resolutions', async () => {
    rpc.raw.request.mockResolvedValueOnce({ conflicts: [], merged: ['u-a'] });
    const res = await bridge.orchestrateResolveConflict('run-1', [
      { conflictIndex: 0, keepUnitId: 'u-a' },
    ]);
    expect(rpc.raw.request).toHaveBeenCalledWith(
      'orchestrate/resolveConflict',
      { runId: 'run-1', resolutions: [{ conflictIndex: 0, keepUnitId: 'u-a' }] },
      { timeoutMs: 60000 },
    );
    expect(res.conflicts).toEqual([]);
  });
});
