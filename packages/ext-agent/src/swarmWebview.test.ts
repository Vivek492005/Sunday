// Tests for the swarm webview pure state reducer (`applySwarmEvent`).
// vscode-free: `vscode` is mocked so only the vscode-free exports are used.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  SWARM_COLUMNS,
  SWARM_VIEW_TYPE,
  applySwarmEvent,
  emptySwarmState,
} from './swarmWebview.js';
import type { SwarmEvent, SwarmState } from './swarmWebview.js';

function evt(partial: Partial<SwarmEvent> = {}): SwarmEvent {
  return { unitId: 'u1', title: 'Unit one', status: 'queued', ...partial };
}

describe('applySwarmEvent', () => {
  it('creates an entry for an unknown unit', () => {
    const next = applySwarmEvent(emptySwarmState(), evt());
    expect(next.units).toHaveLength(1);
    expect(next.units[0]).toMatchObject({
      unitId: 'u1',
      title: 'Unit one',
      status: 'queued',
    });
  });

  it('walks queued -> running -> review -> merged', () => {
    let state: SwarmState = emptySwarmState();
    state = applySwarmEvent(state, evt({ status: 'queued' }));
    state = applySwarmEvent(state, evt({ status: 'running', detail: 'coding…' }));
    state = applySwarmEvent(state, evt({ status: 'review', detail: 'awaiting verifier' }));
    state = applySwarmEvent(state, evt({ status: 'merged', detail: 'merged to main' }));
    expect(state.units).toHaveLength(1);
    expect(state.units[0].status).toBe('merged');
    expect(state.units[0].detail).toBe('merged to main');
  });

  it('moves a failed unit into the failed status', () => {
    let state: SwarmState = emptySwarmState();
    state = applySwarmEvent(state, evt({ status: 'running' }));
    state = applySwarmEvent(state, evt({ status: 'failed', detail: 'tests red' }));
    expect(state.units).toHaveLength(1);
    expect(state.units[0].status).toBe('failed');
    expect(state.units[0].detail).toBe('tests red');
  });

  it('updates the existing unit instead of duplicating it', () => {
    let state: SwarmState = emptySwarmState();
    state = applySwarmEvent(state, evt({ unitId: 'u1', status: 'queued' }));
    state = applySwarmEvent(state, evt({ unitId: 'u2', status: 'queued' }));
    state = applySwarmEvent(state, evt({ unitId: 'u1', status: 'running' }));
    expect(state.units).toHaveLength(2);
    const u1 = state.units.find((u) => u.unitId === 'u1');
    const u2 = state.units.find((u) => u.unitId === 'u2');
    expect(u1?.status).toBe('running');
    expect(u2?.status).toBe('queued');
  });

  it('does not mutate the input state', () => {
    const before: SwarmState = emptySwarmState();
    const next = applySwarmEvent(before, evt());
    expect(before.units).toHaveLength(0);
    expect(next).not.toBe(before);
    const again = applySwarmEvent(next, evt({ status: 'running' }));
    expect(next.units[0].status).toBe('queued');
    expect(again.units[0].status).toBe('running');
  });

  it('refreshes the title from the latest event', () => {
    let state: SwarmState = emptySwarmState();
    state = applySwarmEvent(state, evt({ status: 'queued', title: 'Old title' }));
    state = applySwarmEvent(state, evt({ status: 'running', title: 'New title' }));
    expect(state.units[0].title).toBe('New title');
  });
});

describe('swarm board constants', () => {
  it('exposes the sunday.swarmView view type', () => {
    expect(SWARM_VIEW_TYPE).toBe('sunday.swarmView');
  });

  it('defines exactly the four Kanban columns in order', () => {
    expect(SWARM_COLUMNS.map((c) => c.key)).toEqual(['queued', 'running', 'review', 'merged']);
    expect(SWARM_COLUMNS.map((c) => c.label)).toEqual(['Queued', 'Running', 'Review', 'Merged']);
  });
});
