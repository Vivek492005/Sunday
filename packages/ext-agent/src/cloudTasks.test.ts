// Tests for the A1 cloud-task commands: submit (input validation, client
// call), list (quickpick + detail), and the 30s polling loop (completion
// notifications, silence when disabled/signed out). `vscode` is mocked;
// fetch is injected into CloudTaskClient.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const registered = new Map<string, (...args: any[]) => unknown>();
  return {
    registered,
    window: {
      showInputBox: vi.fn(),
      showQuickPick: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn((id: string, fn: (...args: any[]) => unknown) => {
        registered.set(id, fn);
        return { dispose: () => undefined };
      }),
      executeCommand: vi.fn(async () => undefined),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({ get: (_k: string, def: unknown) => def })),
    },
    authentication: { getSession: vi.fn(async () => undefined) },
  };
});

vi.mock('vscode', () => ({
  window: mocks.window,
  commands: mocks.commands,
  workspace: mocks.workspace,
  authentication: mocks.authentication,
}));

import {
  CLOUD_TASK_LIST_COMMAND,
  CLOUD_TASK_SUBMIT_COMMAND,
  CloudTaskClient,
  listCloudTasks,
  registerCloudTaskCommands,
  startCloudTaskPolling,
  submitCloudTask,
  type CloudTask,
} from './cloudTasks.js';

const TASK: CloudTask = {
  id: 'task_1',
  prompt: 'refactor auth',
  status: 'queued',
  created_at: new Date('2026-10-08T10:00:00Z').toISOString(),
};

function makeFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const call = {
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const path = new URL(url).pathname;
    const key = `${call.method} ${path}`;
    if (!(key in routes)) {
      return { ok: false, status: 404, text: async () => 'nope', json: async () => ({}) } as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(routes[key]),
      json: async () => routes[key],
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

function makeDeps(overrides: Partial<{ tasks: CloudTask[]; enabled: boolean; submitResult: CloudTask }> = {}) {
  const { fetchFn, calls } = makeFetch({
    'POST /agent/tasks': { task: overrides.submitResult ?? TASK },
    'GET /agent/tasks': { tasks: overrides.tasks ?? [TASK] },
  });
  const logs: string[] = [];
  const client = new CloudTaskClient('https://gw.test', async () => 'tok', fetchFn);
  const deps = {
    makeClient: () => client,
    isEnabled: () => overrides.enabled ?? true,
    log: (m: string) => logs.push(m),
  };
  return { deps, calls, logs };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registered.clear();
});

describe('CloudTaskClient', () => {
  it('submits with prompt + repo context', async () => {
    const { deps, calls } = makeDeps();
    const task = await deps.makeClient().submit('do x', 'repo: sunday');
    expect(task.id).toBe('task_1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { prompt: 'do x', repo_context: 'repo: sunday' },
    });
  });

  it('throws a clear error when signed out', async () => {
    const client = new CloudTaskClient('https://gw.test', async () => undefined);
    await expect(client.list()).rejects.toThrow(/Not signed in/);
  });
});

describe('submitCloudTask', () => {
  it('prompts for prompt + context and submits', async () => {
    const { deps, calls } = makeDeps();
    mocks.window.showInputBox
      .mockResolvedValueOnce('  refactor auth  ')
      .mockResolvedValueOnce('repo: sunday');
    await submitCloudTask(deps);
    expect(calls[0]!.body).toEqual({ prompt: 'refactor auth', repo_context: 'repo: sunday' });
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('queued'),
    );
  });

  it('no-ops when the prompt box is dismissed', async () => {
    const { deps, calls } = makeDeps();
    mocks.window.showInputBox.mockResolvedValueOnce(undefined);
    await submitCloudTask(deps);
    expect(calls).toEqual([]);
  });

  it('shows an error when the gateway rejects', async () => {
    const { fetchFn } = makeFetch({});
    const deps = {
      makeClient: () => new CloudTaskClient('https://gw.test', async () => 'tok', fetchFn),
      log: () => undefined,
    };
    mocks.window.showInputBox.mockResolvedValueOnce('x').mockResolvedValueOnce('');
    await submitCloudTask(deps);
    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });
});

describe('listCloudTasks', () => {
  it('shows tasks in a quickpick and displays the selected result', async () => {
    const done: CloudTask = { ...TASK, status: 'completed', result: 'all green' };
    const { deps } = makeDeps({ tasks: [done] });
    mocks.window.showQuickPick.mockResolvedValueOnce({ label: done.id, task: done });
    await listCloudTasks(deps);
    expect(mocks.window.showQuickPick).toHaveBeenCalled();
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('all green'),
    );
  });

  it('informs when there are no tasks', async () => {
    const { deps } = makeDeps({ tasks: [] });
    await listCloudTasks(deps);
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('No cloud tasks'),
    );
    expect(mocks.window.showQuickPick).not.toHaveBeenCalled();
  });
});

describe('startCloudTaskPolling', () => {
  it('notifies when a task completes between polls', async () => {
    vi.useFakeTimers();
    try {
      let tasks: CloudTask[] = [{ ...TASK, status: 'claimed' }];
      const { fetchFn } = makeFetch({});
      const client = {
        list: async () => tasks,
      } as unknown as CloudTaskClient;
      const logs: string[] = [];
      const deps = { makeClient: () => client, isEnabled: () => true, log: (m: string) => logs.push(m) };
      const ctx = { subscriptions: [] as unknown[] } as unknown as import('vscode').ExtensionContext;
      const sub = startCloudTaskPolling(ctx, deps, 30_000);
      // Prime the baseline.
      await vi.advanceTimersByTimeAsync(0);
      // Task completes.
      tasks = [{ ...TASK, status: 'completed', result: 'done' }];
      mocks.window.showInformationMessage.mockResolvedValueOnce(undefined);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('completed'),
        'View',
      );
      sub.dispose();
      expect(fetchFn).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not notify on first sighting and stays silent when disabled', async () => {
    vi.useFakeTimers();
    try {
      const { deps } = makeDeps({ tasks: [{ ...TASK, status: 'completed' }] });
      const ctx = { subscriptions: [] as unknown[] } as unknown as import('vscode').ExtensionContext;
      const sub = startCloudTaskPolling(ctx, { ...deps, isEnabled: () => false }, 30_000);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mocks.window.showInformationMessage).not.toHaveBeenCalled();
      sub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('registerCloudTaskCommands', () => {
  it('registers submit + list commands', () => {
    const { deps } = makeDeps();
    const ctx = { subscriptions: [] as unknown[] } as unknown as import('vscode').ExtensionContext;
    registerCloudTaskCommands(ctx, deps);
    expect(mocks.registered.has(CLOUD_TASK_SUBMIT_COMMAND)).toBe(true);
    expect(mocks.registered.has(CLOUD_TASK_LIST_COMMAND)).toBe(true);
  });
});
