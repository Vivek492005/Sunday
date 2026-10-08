// Tests for the Phase 9.b admin plan toggle command: key-missing path
// (warning, no fetch), plan quickpick + user-id input, POST shape
// (URL, x-admin-key header, body), success + error messaging. `vscode` is
// mocked; fetch is injected. The admin key must never appear in logs.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const registered = new Map<string, (...args: any[]) => unknown>();
  return {
    registered,
    config: { adminKey: '', gatewayUrl: '' },
    logs: [] as string[],
    window: {
      showInputBox: vi.fn(),
      showQuickPick: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
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
      getConfiguration: vi.fn(() => ({
        get: (k: string, def: unknown) => {
          if (k === 'admin.key') return mocks.config.adminKey;
          if (k === 'cloudTasks.gatewayUrl') return mocks.config.gatewayUrl;
          return def;
        },
      })),
    },
  };
});

vi.mock('vscode', () => ({
  window: mocks.window,
  commands: mocks.commands,
  workspace: mocks.workspace,
}));

import {
  ADMIN_KEY_CONFIG,
  ADMIN_SET_PLAN_COMMAND,
  adminSetPlan,
  registerAdminPlanCommand,
} from './adminPlan.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function makeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

const PRO_VIEW = {
  user_id: 'u_abc123',
  plan: 'pro',
  status: 'active',
  renews_at: null,
  entitlements: { 'managed_models.daily_requests': 1500 },
  cached_at: '2026-10-08T00:00:00.000Z',
  valid_until: '2026-10-08T01:00:00.000Z',
};

function deps(fetchFn?: typeof fetch) {
  return { fetchFn, log: (msg: string) => mocks.logs.push(msg) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registered.clear();
  mocks.logs.length = 0;
  mocks.config.adminKey = '';
  mocks.config.gatewayUrl = '';
});

describe('adminSetPlan', () => {
  it('warns and aborts without fetching when no admin key is configured', async () => {
    const { fetchFn, calls } = makeFetch(200, PRO_VIEW);
    await adminSetPlan(deps(fetchFn));
    expect(mocks.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(String(mocks.window.showWarningMessage.mock.calls[0]?.[0])).toContain('sunday.admin.key');
    expect(calls).toHaveLength(0);
    expect(mocks.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('POSTs the plan with the x-admin-key header and shows the result', async () => {
    mocks.config.adminKey = 'k-secret';
    mocks.config.gatewayUrl = 'https://gw.example.com/';
    mocks.window.showQuickPick.mockResolvedValueOnce({ label: 'Pro', plan: 'pro' });
    mocks.window.showInputBox.mockResolvedValueOnce('u_abc123');
    const { fetchFn, calls } = makeFetch(200, PRO_VIEW);

    await adminSetPlan(deps(fetchFn));

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://gw.example.com/admin/users/u_abc123/plan');
    expect(c.method).toBe('POST');
    expect(c.headers['x-admin-key']).toBe('k-secret');
    expect(c.body).toEqual({ plan: 'pro' });
    expect(mocks.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const msg = String(mocks.window.showInformationMessage.mock.calls[0]?.[0]);
    expect(msg).toContain('u_abc123');
    expect(msg).toContain('pro');
    expect(msg).toContain('1500');
    // The admin key must never appear in logs or messages.
    expect(mocks.logs.join('\n')).not.toContain('k-secret');
    expect(msg).not.toContain('k-secret');
  });

  it('aborts quietly when the quickpick or input is dismissed', async () => {
    mocks.config.adminKey = 'k-secret';
    mocks.window.showQuickPick.mockResolvedValueOnce(undefined);
    const { fetchFn, calls } = makeFetch(200, PRO_VIEW);
    await adminSetPlan(deps(fetchFn));
    expect(calls).toHaveLength(0);

    mocks.window.showQuickPick.mockResolvedValueOnce({ label: 'Smart', plan: 'smart' });
    mocks.window.showInputBox.mockResolvedValueOnce(undefined);
    await adminSetPlan(deps(fetchFn));
    expect(calls).toHaveLength(0);
    expect(mocks.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows an error message on gateway failure', async () => {
    mocks.config.adminKey = 'k-secret';
    mocks.window.showQuickPick.mockResolvedValueOnce({ label: 'Basic', plan: 'basic' });
    mocks.window.showInputBox.mockResolvedValueOnce('u_nope');
    const { fetchFn } = makeFetch(404, { error: { code: 'unknown_user' } });
    await adminSetPlan(deps(fetchFn));
    expect(mocks.window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(String(mocks.window.showErrorMessage.mock.calls[0]?.[0])).toContain('404');
    expect(mocks.logs.join('\n')).not.toContain('k-secret');
  });

  it('shows an error message when the gateway is unreachable', async () => {
    mocks.config.adminKey = 'k-secret';
    mocks.window.showQuickPick.mockResolvedValueOnce({ label: 'Pro', plan: 'pro' });
    mocks.window.showInputBox.mockResolvedValueOnce('u_abc123');
    const fetchFn = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    await adminSetPlan(deps(fetchFn));
    expect(mocks.window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(mocks.logs.join('\n')).not.toContain('k-secret');
  });
});

describe('registerAdminPlanCommand', () => {
  it('registers sunday.admin.setPlan and honors the config key name', async () => {
    expect(ADMIN_KEY_CONFIG).toBe('admin.key');
    const context = { subscriptions: [] as unknown[] } as unknown as import('vscode').ExtensionContext;
    registerAdminPlanCommand(context, deps());
    expect(mocks.registered.has(ADMIN_SET_PLAN_COMMAND)).toBe(true);
    expect(context.subscriptions).toHaveLength(1);

    // Invoking the registered command with no key configured warns.
    const fn = mocks.registered.get(ADMIN_SET_PLAN_COMMAND)!;
    await fn();
    expect(mocks.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });
});
