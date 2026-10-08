// Tests for the A5 scheduler commands: create (multi-input flow +
// validation), list (quickpick + enable/disable/run/delete actions),
// delete (confirm), input validators, and the SchedulerSource used by
// Mission Control. `vscode` is mocked; HostBridge is a stub.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const registered = new Map<string, (...args: any[]) => unknown>();
  return {
    registered,
    window: {
      showInputBox: vi.fn(),
      showQuickPick: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      withProgress: vi.fn(async (_opts: any, task: (p: any) => unknown) => task({ report: () => undefined })),
    },
    commands: {
      registerCommand: vi.fn((id: string, fn: (...args: any[]) => unknown) => {
        registered.set(id, fn);
        return { dispose: () => undefined };
      }),
    },
    workspace: { getConfiguration: vi.fn(() => ({ get: (_k: string, def: unknown) => def })) },
    ProgressLocation: { Notification: 15 },
  };
});

vi.mock('vscode', () => ({
  window: mocks.window,
  commands: mocks.commands,
  workspace: mocks.workspace,
  ProgressLocation: mocks.ProgressLocation,
}));

import {
  SCHEDULE_CREATE_COMMAND,
  SCHEDULE_DELETE_COMMAND,
  SCHEDULE_LIST_COMMAND,
  createSchedule,
  deleteSchedule,
  listSchedules,
  makeSchedulerSource,
  registerSchedulerCommands,
  validateCronInput,
  validateScheduleName,
} from './scheduler.js';

function makeBridge(schedules: Array<{ name: string; cron: string; enabled: boolean }> = []) {
  const store = new Map(schedules.map((s) => [s.name, { ...s, prompt: 'p' }]));
  return {
    schedulerCreate: vi.fn(async (p: any) => {
      if (store.has(p.name)) throw new Error('already exists');
      store.set(p.name, { ...p, enabled: true });
      return { schedule: store.get(p.name) };
    }),
    schedulerUpdate: vi.fn(async (p: any) => {
      const s = store.get(p.name);
      if (!s) throw new Error('unknown schedule');
      Object.assign(s, p);
      return { schedule: s };
    }),
    schedulerDelete: vi.fn(async (p: any) => {
      if (!store.delete(p.name)) throw new Error('unknown schedule');
      return { deleted: true };
    }),
    schedulerStatus: vi.fn(async () => ({
      schedules: [...store.values()].map((s) => ({ ...s, lastStatus: 'completed' as const })),
      running: [],
    })),
    schedulerRunNow: vi.fn(async (p: any) => ({
      run: { name: p.name, startedAt: '', finishedAt: '', status: 'completed' as const },
    })),
    store,
  };
}

function makeDeps(bridge: ReturnType<typeof makeBridge>) {
  return {
    getBridge: async () => bridge as never,
    log: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registered.clear();
});

describe('validators', () => {
  it('validates schedule names', () => {
    expect(validateScheduleName('nightly-1')).toBeUndefined();
    expect(validateScheduleName('')).toBeDefined();
    expect(validateScheduleName('../evil')).toBeDefined();
    expect(validateScheduleName('a'.repeat(65))).toBeDefined();
  });

  it('validates cron input loosely', () => {
    expect(validateCronInput('0 9 * * 1-5')).toBeUndefined();
    expect(validateCronInput('')).toBeDefined();
    expect(validateCronInput('* * *')).toBeDefined();
  });
});

describe('createSchedule', () => {
  it('walks the 3-step input and creates the schedule', async () => {
    const bridge = makeBridge();
    const deps = makeDeps(bridge);
    mocks.window.showInputBox
      .mockResolvedValueOnce('morning')
      .mockResolvedValueOnce('0 9 * * 1-5')
      .mockResolvedValueOnce('brief me');
    await createSchedule(deps);
    expect(bridge.schedulerCreate).toHaveBeenCalledWith({
      name: 'morning',
      cron: '0 9 * * 1-5',
      prompt: 'brief me',
    });
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('created'),
    );
  });

  it('aborts when any step is dismissed', async () => {
    const bridge = makeBridge();
    mocks.window.showInputBox.mockResolvedValueOnce(undefined);
    await createSchedule(makeDeps(bridge));
    expect(bridge.schedulerCreate).not.toHaveBeenCalled();
  });

  it('surfaces daemon errors', async () => {
    const bridge = makeBridge([{ name: 'dup', cron: '* * * * *', enabled: true }]);
    mocks.window.showInputBox
      .mockResolvedValueOnce('dup')
      .mockResolvedValueOnce('* * * * *')
      .mockResolvedValueOnce('x');
    await createSchedule(makeDeps(bridge));
    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('already exists'));
  });
});

describe('listSchedules', () => {
  it('toggles enable/disable from the quickpick', async () => {
    const bridge = makeBridge([{ name: 'job1', cron: '* * * * *', enabled: true }]);
    const deps = makeDeps(bridge);
    mocks.window.showQuickPick
      .mockResolvedValueOnce({ info: { name: 'job1', cron: '* * * * *', enabled: true, running: false } })
      .mockResolvedValueOnce({ label: 'Disable', action: 'toggle' });
    await listSchedules(deps);
    expect(bridge.schedulerUpdate).toHaveBeenCalledWith({ name: 'job1', enabled: false });
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('runs a schedule now with progress', async () => {
    const bridge = makeBridge([{ name: 'job1', cron: '* * * * *', enabled: true }]);
    mocks.window.showQuickPick
      .mockResolvedValueOnce({ info: { name: 'job1', cron: '* * * * *', enabled: true, running: false } })
      .mockResolvedValueOnce({ label: 'Run now', action: 'run' });
    await listSchedules(makeDeps(bridge));
    expect(bridge.schedulerRunNow).toHaveBeenCalledWith({ name: 'job1' });
  });

  it('informs when there are no schedules', async () => {
    const bridge = makeBridge();
    await listSchedules(makeDeps(bridge));
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('No schedules'));
    expect(mocks.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('shows daemon errors', async () => {
    const deps = {
      getBridge: async () => ({ schedulerStatus: async () => { throw new Error('daemon down'); } }) as never,
      log: vi.fn(),
    };
    await listSchedules(deps);
    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('daemon down'));
  });
});

describe('deleteSchedule', () => {
  it('confirms before deleting', async () => {
    const bridge = makeBridge([{ name: 'job1', cron: '* * * * *', enabled: true }]);
    mocks.window.showQuickPick.mockResolvedValueOnce({ info: { name: 'job1' } });
    mocks.window.showWarningMessage.mockResolvedValueOnce('Delete');
    await deleteSchedule(makeDeps(bridge));
    expect(bridge.schedulerDelete).toHaveBeenCalledWith({ name: 'job1' });
  });

  it('aborts when the confirm is dismissed', async () => {
    const bridge = makeBridge([{ name: 'job1', cron: '* * * * *', enabled: true }]);
    mocks.window.showQuickPick.mockResolvedValueOnce({ info: { name: 'job1' } });
    mocks.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await deleteSchedule(makeDeps(bridge));
    expect(bridge.schedulerDelete).not.toHaveBeenCalled();
  });
});

describe('registerSchedulerCommands', () => {
  it('registers the three commands', () => {
    const ctx = { subscriptions: [] as unknown[] } as unknown as import('vscode').ExtensionContext;
    registerSchedulerCommands(ctx, makeDeps(makeBridge()));
    expect(mocks.registered.has(SCHEDULE_CREATE_COMMAND)).toBe(true);
    expect(mocks.registered.has(SCHEDULE_LIST_COMMAND)).toBe(true);
    expect(mocks.registered.has(SCHEDULE_DELETE_COMMAND)).toBe(true);
  });
});

describe('makeSchedulerSource', () => {
  it('adapts the bridge for Mission Control', async () => {
    const bridge = makeBridge([{ name: 'job1', cron: '0 9 * * *', enabled: true }]);
    const src = makeSchedulerSource(makeDeps(bridge));
    const list = await src.listScheduledTasks();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'job1', cron: '0 9 * * *', enabled: true, running: false });
    await src.setScheduleEnabled('job1', false);
    expect(bridge.schedulerUpdate).toHaveBeenCalledWith({ name: 'job1', enabled: false });
    await src.runScheduleNow('job1');
    expect(bridge.schedulerRunNow).toHaveBeenCalledWith({ name: 'job1' });
    await src.deleteSchedule('job1');
    expect(bridge.schedulerDelete).toHaveBeenCalledWith({ name: 'job1' });
  });

  it('returns [] when the sidecar is down', async () => {
    const src = makeSchedulerSource({ getBridge: async () => undefined, log: vi.fn() });
    expect(await src.listScheduledTasks()).toEqual([]);
    await expect(src.setScheduleEnabled('x', true)).rejects.toThrow(/not running/);
  });
});
