// Tests for the A1 CloudTaskRunner: poll lifecycle (list → claim →
// execute → result), disabled/signed-out gates, gateway failures, and
// execution errors. fetch is injected; no network, no daemon.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CloudTaskRunner, type RemoteCloudTask } from './task-runner.js';

interface Call {
  url: string;
  method: string;
  auth?: string;
  body?: unknown;
}

function makeFetch(
  handlers: Record<string, (call: Call) => { status: number; json: unknown }>,
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      auth: headers.get('authorization') ?? undefined,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const path = new URL(url).pathname;
    const handler =
      handlers[`${call.method} ${path}`] ??
      handlers[path] ??
      (() => ({ status: 404, json: { error: 'not found' } }));
    const { status, json } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

const TASK: RemoteCloudTask = { id: 'task_abc', prompt: 'do it', status: 'queued' };

function makeRunner(overrides: {
  tasks?: RemoteCloudTask[];
  enabled?: boolean;
  /** 'signed-out' sentinel distinguishes an explicit signed-out state. */
  token?: string | 'signed-out';
  execute?: (prompt: string) => Promise<string>;
  claimStatus?: number;
} = {}) {
  const calls: Call[] = [];
  const { fetchFn, calls: recorded } = makeFetch({
    'GET /agent/tasks': () => ({ status: 200, json: { tasks: overrides.tasks ?? [TASK] } }),
    [`POST /agent/tasks/${TASK.id}/claim`]: () => ({
      status: overrides.claimStatus ?? 200,
      json: { task: { ...TASK, status: 'claimed' } },
    }),
    [`POST /agent/tasks/${TASK.id}/result`]: (c) => {
      calls.push(c);
      return { status: 200, json: { ok: true } };
    },
  });
  const finished: RemoteCloudTask[] = [];
  const logs: string[] = [];
  const executed: string[] = [];
  const runner = new CloudTaskRunner({
    gatewayUrl: 'https://gateway.test',
    authToken: () => (overrides.token === 'signed-out' ? undefined : (overrides.token ?? 'tok')),
    enabled: () => overrides.enabled ?? true,
    execute: overrides.execute ?? (async (p) => { executed.push(p); return `result for: ${p}`; }),
    fetchFn,
    log: (m) => logs.push(m),
    onTaskFinished: (t) => finished.push(t),
  });
  return { runner, calls: recorded, resultCalls: calls, finished, logs, executed };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('CloudTaskRunner', () => {
  it('runs the full lifecycle: list → claim → execute → post result', async () => {
    const { runner, calls, resultCalls, finished, executed } = makeRunner();
    await runner.pollOnce();
    const methods = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(methods).toEqual([
      'GET /agent/tasks',
      `POST /agent/tasks/${TASK.id}/claim`,
      `POST /agent/tasks/${TASK.id}/result`,
    ]);
    // The token rides as a Bearer credential.
    expect(calls[0]!.auth).toBe('Bearer tok');
    expect(executed).toEqual(['do it']);
    expect(resultCalls[0]!.body).toEqual({ result: 'result for: do it' });
    expect(finished).toHaveLength(1);
    expect(finished[0]!.status).toBe('completed');
  });

  it('does nothing when disabled or signed out', async () => {
    const off = makeRunner({ enabled: false });
    await off.runner.pollOnce();
    expect(off.calls).toEqual([]);

    const anon = makeRunner({ token: 'signed-out' });
    await anon.runner.pollOnce();
    expect(anon.calls).toEqual([]);
    expect(anon.logs).toEqual([]); // silent, not an error
  });

  it('skips non-queued tasks', async () => {
    const { runner, calls } = makeRunner({
      tasks: [{ ...TASK, status: 'completed' }, { ...TASK, id: 'task_done', status: 'failed' }],
    });
    await runner.pollOnce();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/agent/tasks']);
  });

  it('treats a lost claim race as benign (no execute, no result post)', async () => {
    const { runner, resultCalls, executed, finished } = makeRunner({ claimStatus: 409 });
    await runner.pollOnce();
    expect(executed).toEqual([]);
    expect(resultCalls).toEqual([]);
    expect(finished).toEqual([]);
  });

  it('posts an error result when execution throws', async () => {
    const { runner, resultCalls, finished } = makeRunner({
      execute: async () => { throw new Error('model exploded'); },
    });
    await runner.pollOnce();
    expect(resultCalls[0]!.body).toEqual({ error: expect.stringContaining('model exploded') });
    expect(finished[0]!.status).toBe('failed');
  });

  it('survives a dead gateway and an unreachable network', async () => {
    const { fetchFn } = makeFetch({});
    const logs: string[] = [];
    const runner = new CloudTaskRunner({
      gatewayUrl: 'https://gateway.test',
      authToken: () => 'tok',
      enabled: () => true,
      execute: async () => 'x',
      fetchFn: (async () => { throw new Error('fetch failed'); }) as typeof fetch,
      log: (m) => logs.push(m),
    });
    await expect(runner.pollOnce()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('cloud task poll failed'))).toBe(true);
    expect(fetchFn).toBeDefined();
  });

  it('survives a 500 from the gateway', async () => {
    const logs: string[] = [];
    const { fetchFn } = makeFetch({
      'GET /agent/tasks': () => ({ status: 500, json: { error: 'boom' } }),
    });
    const runner = new CloudTaskRunner({
      gatewayUrl: 'https://gateway.test',
      authToken: () => 'tok',
      enabled: () => true,
      execute: async () => 'x',
      fetchFn,
      log: (m) => logs.push(m),
    });
    await runner.pollOnce();
    expect(logs.some((l) => l.includes('gateway 500'))).toBe(true);
  });

  it('never overlaps polls (a slow poll blocks the next)', async () => {
    const { fetchFn, calls } = makeFetch({
      'GET /agent/tasks': () => ({ status: 200, json: { tasks: [] } }),
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runner = new CloudTaskRunner({
      gatewayUrl: 'https://gateway.test',
      authToken: () => 'tok',
      enabled: () => true,
      execute: async () => 'x',
      fetchFn: (async (...a: Parameters<typeof fetch>) => {
        await gate;
        return fetchFn(...a);
      }) as typeof fetch,
    });
    const p1 = runner.pollOnce();
    const p2 = runner.pollOnce(); // must no-op while p1 holds the lock
    await p2;
    release();
    await p1;
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });
});
