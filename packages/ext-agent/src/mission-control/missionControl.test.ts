// Tests for Mission Control (A4): aggregation with mocked sources,
// card actions dispatching to the right source, source adapters mapping
// their backends, and the elapsed/format helpers.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createWebviewPanel: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  commands: { registerCommand: vi.fn(() => ({ dispose: () => undefined })) },
  ViewColumn: { One: 1 },
}));

import { aggregateWork, elapsedMs, escapeHtml, formatElapsed, type WorkItem, type WorkSource } from './types.js';
import {
  makeBrowserSource,
  makeCloudTaskSource,
  makeOrchestrationSource,
  makeScheduleSource,
} from './sources.js';
import { dispatchCardAction } from './missionControl.js';

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'x', kind: 'schedule', name: 'n', status: 'running',
    startedAt: Date.now(), lastLog: [], stoppable: true, restartable: true, ...over,
  };
}

function stubSource(kind: WorkItem['kind'], items: WorkItem[], opts: { fail?: Error } = {}): WorkSource {
  return {
    kind,
    label: kind,
    list: opts.fail ? async () => { throw opts.fail; } : async () => items,
    stop: vi.fn(),
    restart: vi.fn(),
  };
}

describe('aggregateWork', () => {
  it('merges items from all sources', async () => {
    const { items, errors } = await aggregateWork([
      stubSource('schedule', [item({ id: 'a' })]),
      stubSource('browser', [item({ id: 'b', kind: 'browser' })]),
    ]);
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(errors).toEqual([]);
  });

  it('isolates a failing source', async () => {
    const { items, errors } = await aggregateWork([
      stubSource('schedule', [item({ id: 'a' })]),
      stubSource('cloud-task', [], { fail: new Error('gateway down') }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['a']);
    expect(errors).toEqual(['cloud-task: gateway down']);
  });

  it('returns empty when all sources fail', async () => {
    const { items, errors } = await aggregateWork([stubSource('schedule', [], { fail: new Error('x') })]);
    expect(items).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('elapsed/format helpers', () => {
  it('formats durations', () => {
    expect(formatElapsed(5000)).toBe('5s');
    expect(formatElapsed(135000)).toBe('2m 15s');
    expect(formatElapsed(3720000)).toBe('1h 2m');
  });

  it('clamps negative elapsed to 0', () => {
    expect(elapsedMs(item({ startedAt: Date.now() + 10000 }))).toBe(0);
  });

  it('escapes HTML', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});

describe('dispatchCardAction', () => {
  it('routes stop to the matching source and item', async () => {
    const sched = stubSource('schedule', [item({ id: 'nightly' })]);
    const browser = stubSource('browser', [item({ id: 's1', kind: 'browser' })]);
    await dispatchCardAction([sched, browser], 'browser', 'stop', 's1');
    expect(browser.stop).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    expect(sched.stop).not.toHaveBeenCalled();
  });

  it('routes restart', async () => {
    const sched = stubSource('schedule', [item({ id: 'nightly' })]);
    await dispatchCardAction([sched], 'schedule', 'restart', 'nightly');
    expect(sched.restart).toHaveBeenCalled();
  });

  it('throws for unknown kind or missing item', async () => {
    await expect(dispatchCardAction([], 'schedule', 'stop', 'x')).rejects.toThrow(/No source/);
    await expect(
      dispatchCardAction([stubSource('schedule', [])], 'schedule', 'stop', 'x'),
    ).rejects.toThrow(/not found/);
  });
});

describe('source adapters', () => {
  const noBridge = async () => undefined;

  it('orchestration source maps run state', async () => {
    const bridge = {
      orchestrateStatus: vi.fn(async (runId: string) => ({
        runId, goal: 'build the thing', parallel: true, status: 'running',
        units: [{ id: 'u1', title: 'unit one', status: 'running' }],
        conflicts: [], createdAt: new Date(Date.now() - 60000).toISOString(), updatedAt: '',
      })),
      orchestrateStop: vi.fn(async () => ({ stopped: true })),
    };
    const src = makeOrchestrationSource({
      getBridge: async () => bridge as never, log: () => undefined, getRunIds: () => ['r1'],
    });
    const items = await src.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'r1', kind: 'orchestration', status: 'running', stoppable: true });
    expect(items[0].lastLog[0]).toContain('unit one');
    await src.stop(items[0]);
    expect(bridge.orchestrateStop).toHaveBeenCalledWith('r1');
    await expect(src.restart(items[0])).rejects.toThrow(/cannot be restarted/);
  });

  it('orchestration source skips runs the daemon forgot', async () => {
    const src = makeOrchestrationSource({
      getBridge: async () => ({ orchestrateStatus: async () => { throw new Error('RunNotFound'); } }) as never,
      log: vi.fn(), getRunIds: () => ['gone'],
    });
    expect(await src.list()).toEqual([]);
  });

  it('browser source maps sessions', async () => {
    const closeSession = vi.fn();
    const src = makeBrowserSource({
      getBridge: noBridge, log: () => undefined,
      getSessions: () => [{ id: 's1', url: 'https://example.com', startedAt: 123, hasControl: false }],
      closeSession,
    });
    const items = await src.list();
    expect(items[0]).toMatchObject({ id: 's1', kind: 'browser', name: 'https://example.com', stoppable: true });
    await src.stop(items[0]);
    expect(closeSession).toHaveBeenCalledWith('s1');
  });

  it('cloud task source maps gateway tasks', async () => {
    const src = makeCloudTaskSource({
      getBridge: noBridge, log: () => undefined,
      makeClient: () => ({
        list: async () => [
          { id: 't1', prompt: 'do stuff', status: 'queued', created_at: new Date().toISOString() },
          { id: 't2', prompt: 'do more', status: 'failed', created_at: '', error: 'boom' },
        ],
      }) as never,
    });
    const items = await src.list();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 't1', kind: 'cloud-task', status: 'queued', stoppable: false });
    expect(items[1].lastLog[0]).toBe('boom');
    await expect(src.stop(items[0])).rejects.toThrow(/cannot be stopped/);
  });

  it('schedule source maps scheduled tasks', async () => {
    const scheduler = {
      listScheduledTasks: async () => [
        { name: 'nightly', cron: '0 2 * * *', enabled: true, running: false, lastStatus: 'completed' },
        { name: 'old', cron: '0 1 * * *', enabled: false, running: false },
      ],
      setScheduleEnabled: vi.fn(async () => undefined),
      runScheduleNow: vi.fn(async () => undefined),
      deleteSchedule: vi.fn(async () => undefined),
    };
    const src = makeScheduleSource(scheduler, () => undefined);
    const items = await src.list();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'nightly', kind: 'schedule', status: 'enabled', stoppable: true, restartable: true });
    expect(items[1].status).toBe('disabled');
    await src.stop(items[0]);
    expect(scheduler.setScheduleEnabled).toHaveBeenCalledWith('nightly', false);
    await src.restart(items[0]);
    expect(scheduler.runScheduleNow).toHaveBeenCalledWith('nightly');
  });

  it('schedule section is empty with a note when no schedules exist', async () => {
    const src = makeScheduleSource({
      listScheduledTasks: async () => [],
      setScheduleEnabled: async () => undefined,
      runScheduleNow: async () => undefined,
      deleteSchedule: async () => undefined,
    }, () => undefined);
    expect(await src.list()).toEqual([]);
    expect(src.emptyNote).toContain('Create Schedule');
  });
});
