// Unit tests for the framework-free manager logic (managerClient).
// No DOM, no React, no network. The "host" is a mock collecting outbound
// messages — the same pattern as ui-chat's chatClient tests.
import { describe, expect, it } from 'vitest';
import {
  addWorktree,
  applyManagerError,
  applyManagerState,
  clearError,
  createCheckpoint,
  createInitialState,
  mergeWorktree,
  removeWorktree,
  requestRefresh,
  restoreCheckpoint,
  setRefreshing,
  shortSha,
  stopTurn,
  type ManagerHost,
  type OutboundMessage,
} from './managerClient.js';

function makeHost(): ManagerHost & { posted: OutboundMessage[] } {
  const posted: OutboundMessage[] = [];
  return { posted, postMessage: (m) => posted.push(m) };
}

describe('managerClient state', () => {
  it('starts refreshing with empty lists', () => {
    const s = createInitialState();
    expect(s.refreshing).toBe(true);
    expect(s.agents).toEqual([]);
    expect(s.checkpoints).toEqual([]);
    expect(s.worktrees).toEqual([]);
    expect(s.error).toBeUndefined();
  });

  it('applies a state snapshot and clears refreshing/error', () => {
    let s = applyManagerError(createInitialState(), 'boom');
    s = applyManagerState(s, {
      type: 'sunday/manager/state',
      workspaceRoot: '/w',
      repoRoot: '/w/repo',
      agents: [
        { id: 'a1', title: 'T1', updatedAt: '2026-10-01T00:00:00Z', activeTurn: 't1' },
        { id: 'a2', title: 'T2', updatedAt: '2026-10-01T00:00:00Z' },
      ],
      checkpoints: [{ id: 'c1', sha: 'abc', label: 'L', createdAt: '2026-10-01T00:00:00Z' }],
      worktrees: [{ path: '/wt', branch: 'feat', head: 'def' }],
    });
    expect(s.refreshing).toBe(false);
    expect(s.error).toBeUndefined();
    expect(s.workspaceRoot).toBe('/w');
    expect(s.agents).toHaveLength(2);
    expect(s.agents[0].activeTurn).toBe('t1');
    expect(s.checkpoints[0].label).toBe('L');
    expect(s.worktrees[0].branch).toBe('feat');
  });

  it('records errors and clears them', () => {
    let s = createInitialState();
    s = applyManagerError(s, 'daemon down');
    expect(s.error).toBe('daemon down');
    expect(s.refreshing).toBe(false);
    s = clearError(s);
    expect(s.error).toBeUndefined();
  });

  it('toggles refreshing', () => {
    let s = createInitialState();
    s = setRefreshing(s, false);
    expect(s.refreshing).toBe(false);
  });

  it('shortens shas for display', () => {
    expect(shortSha('abcdef1234567890')).toBe('abcdef123456');
    expect(shortSha('abc')).toBe('abc');
  });
});

describe('managerClient outbound actions', () => {
  it('refresh posts sunday/manager/refresh', () => {
    const h = makeHost();
    requestRefresh(h);
    expect(h.posted).toEqual([{ type: 'sunday/manager/refresh' }]);
  });

  it('stopTurn posts the turn id, ignores empty', () => {
    const h = makeHost();
    stopTurn(h, 'turn-9');
    expect(h.posted).toEqual([{ type: 'sunday/manager/stop-turn', turnId: 'turn-9' }]);
    stopTurn(h, '');
    expect(h.posted).toHaveLength(1);
  });

  it('createCheckpoint trims the label and omits it when blank', () => {
    const h = makeHost();
    createCheckpoint(h, '  before big change  ');
    createCheckpoint(h, '   ');
    createCheckpoint(h);
    expect(h.posted).toEqual([
      { type: 'sunday/checkpoint/create', label: 'before big change' },
      { type: 'sunday/checkpoint/create' },
      { type: 'sunday/checkpoint/create' },
    ]);
  });

  it('restoreCheckpoint posts the id, ignores empty', () => {
    const h = makeHost();
    restoreCheckpoint(h, 'sha-1');
    restoreCheckpoint(h, '');
    expect(h.posted).toEqual([{ type: 'sunday/checkpoint/restore', id: 'sha-1' }]);
  });

  it('addWorktree trims branch/path, ignores blank branch', () => {
    const h = makeHost();
    addWorktree(h, '  feature/y  ', ' /tmp/wt ');
    addWorktree(h, 'feature/z');
    addWorktree(h, '   ');
    expect(h.posted).toEqual([
      { type: 'sunday/worktree/add', branch: 'feature/y', path: '/tmp/wt' },
      { type: 'sunday/worktree/add', branch: 'feature/z' },
    ]);
  });

  it('removeWorktree posts path and force flag', () => {
    const h = makeHost();
    removeWorktree(h, '/tmp/wt', true);
    removeWorktree(h, '/tmp/wt2');
    expect(h.posted).toEqual([
      { type: 'sunday/worktree/remove', path: '/tmp/wt', force: true },
      { type: 'sunday/worktree/remove', path: '/tmp/wt2', force: false },
    ]);
  });

  it('mergeWorktree posts path with optional target', () => {
    const h = makeHost();
    mergeWorktree(h, '/tmp/wt', 'main');
    mergeWorktree(h, '/tmp/wt2', '  ');
    expect(h.posted).toEqual([
      { type: 'sunday/worktree/merge', path: '/tmp/wt', target: 'main' },
      { type: 'sunday/worktree/merge', path: '/tmp/wt2' },
    ]);
  });
});
