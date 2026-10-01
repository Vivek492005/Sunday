// Unit tests for the orchestration slice of managerClient (parallel agents
// phase): state snapshots, the active-run helper, and the outbound actions
// (stop-all, per-conflict resolve, open-diff). No DOM, no React, no network.
import { describe, expect, it } from 'vitest';
import {
  activeOrchestrationRun,
  applyOrchestrationState,
  createInitialState,
  openConflictDiff,
  resolveConflict,
  stopAllOrchestration,
  type ManagerHost,
  type OrchestrationRunView,
  type OutboundMessage,
} from './managerClient.js';

function makeHost(): ManagerHost & { posted: OutboundMessage[] } {
  const posted: OutboundMessage[] = [];
  return { posted, postMessage: (m) => posted.push(m) };
}

const RUN: OrchestrationRunView = {
  runId: 'run-1',
  goal: 'ship dark mode',
  parallel: true,
  status: 'conflicted',
  units: [
    {
      id: 'u-a',
      title: 'Toggle',
      status: 'done',
      worktreePath: '/wt/a',
      model: 'groq:llama-3.1-8b-instant',
      steps: 4,
      log: ['done'],
    },
    { id: 'u-b', title: 'Wiring', status: 'done', log: [] },
  ],
  conflicts: [
    {
      index: 0,
      file: 'src/settings.ts',
      hunks: [
        { file: 'src/settings.ts', unitA: 'u-a', unitB: 'u-b', rangeA: [12, 34], rangeB: [10, 30] },
      ],
    },
  ],
  updatedAt: '2026-10-01T20:05:00Z',
};

describe('managerClient orchestration', () => {
  it('starts with no orchestration runs', () => {
    expect(createInitialState().orchestration).toEqual([]);
  });

  it('applyOrchestrationState replaces the runs and clears refreshing', () => {
    const s = applyOrchestrationState(createInitialState(), [RUN]);
    expect(s.refreshing).toBe(false);
    expect(s.orchestration).toHaveLength(1);
    expect(s.orchestration[0].runId).toBe('run-1');
    expect(s.orchestration[0].units).toHaveLength(2);
    expect(s.orchestration[0].conflicts[0].file).toBe('src/settings.ts');
    const s2 = applyOrchestrationState(s, []);
    expect(s2.orchestration).toEqual([]);
  });

  it('applyOrchestrationState tolerates non-array input', () => {
    const s = applyOrchestrationState(createInitialState(), undefined as any);
    expect(s.orchestration).toEqual([]);
  });

  it('activeOrchestrationRun finds running/conflicted runs', () => {
    const running = { ...RUN, runId: 'run-2', status: 'running' as const, conflicts: [] };
    const done = { ...RUN, runId: 'run-3', status: 'done' as const };
    const s = applyOrchestrationState(createInitialState(), [done, running]);
    expect(activeOrchestrationRun(s)?.runId).toBe('run-2');
    const s2 = applyOrchestrationState(createInitialState(), [done]);
    expect(activeOrchestrationRun(s2)).toBeUndefined();
  });

  it('stopAllOrchestration posts the stop-all message', () => {
    const host = makeHost();
    stopAllOrchestration(host);
    expect(host.posted).toEqual([{ type: 'sunday/orchestration/stopAll' }]);
  });

  it('resolveConflict posts runId + conflictIndex + keepUnitId', () => {
    const host = makeHost();
    resolveConflict(host, 'run-1', 0, 'u-a');
    expect(host.posted).toEqual([
      { type: 'sunday/orchestration/resolve', runId: 'run-1', conflictIndex: 0, keepUnitId: 'u-a' },
    ]);
  });

  it('resolveConflict ignores invalid input', () => {
    const host = makeHost();
    resolveConflict(host, '', 0, 'u-a');
    resolveConflict(host, 'run-1', -1, 'u-a');
    resolveConflict(host, 'run-1', 0, '');
    expect(host.posted).toEqual([]);
  });

  it('openConflictDiff posts runId + conflictIndex', () => {
    const host = makeHost();
    openConflictDiff(host, 'run-1', 0);
    expect(host.posted).toEqual([
      { type: 'sunday/orchestration/openDiff', runId: 'run-1', conflictIndex: 0 },
    ]);
    const host2 = makeHost();
    openConflictDiff(host2, '', 0);
    expect(host2.posted).toEqual([]);
  });
});
