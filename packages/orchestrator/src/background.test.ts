import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundEvent, ChatEvent } from '@sunday/protocol';
import {
  FileBackgroundStateStore,
  cancelBackgroundRun,
  createBackgroundHandlers,
  getBackgroundStatus,
  reconcileBackgroundRuns,
  registerBackgroundMethods,
  startBackgroundRun,
  type BackgroundAgentHost,
  type GitOps,
} from './background.js';
import { BackgroundAgentError } from './errors.js';
import type { SubAgentRunOptions } from './host.js';

function makeStore(): FileBackgroundStateStore {
  return new FileBackgroundStateStore(mkdtempSync(join(tmpdir(), 'bg-test-')));
}

function makeGitOps(over: Partial<GitOps> = {}): GitOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hasChanges: async () => {
      calls.push('hasChanges');
      return true;
    },
    commitAll: async (_cwd, message) => {
      calls.push(`commitAll:${message.slice(0, 24)}`);
      return 'deadbeef'.repeat(5).slice(0, 40);
    },
    pushBranch: async (_cwd, branch) => {
      calls.push(`pushBranch:${branch}`);
    },
    createPR: async (o) => {
      calls.push(`createPR:${o.title.slice(0, 24)}`);
      return { url: 'https://github.com/acme/repo/pull/42', number: 42 };
    },
    ...over,
  };
}

interface MockHost {
  host: BackgroundAgentHost;
  events: BackgroundEvent[];
  dispatched: Array<{ method: string; params: unknown }>;
  subAgentCalls: SubAgentRunOptions[];
}

function makeHost(opts: { failAgent?: boolean; hangAgent?: boolean } = {}): MockHost {
  const events: BackgroundEvent[] = [];
  const dispatched: Array<{ method: string; params: unknown }> = [];
  const subAgentCalls: SubAgentRunOptions[] = [];
  const host = {
    router: {},
    tools: { call: vi.fn() },
    defaultModel: 'test-model',
    dispatch: async (method: string, params: unknown) => {
      dispatched.push({ method, params });
      if (method === 'worktree/add') {
        const p = params as { branch: string };
        return { path: `/tmp/bg-wt/${p.branch.replace(/\//g, '-')}`, branch: p.branch };
      }
      if (method === 'worktree/remove') return { removed: true };
      throw new Error(`unexpected dispatch: ${method}`);
    },
    notify: () => undefined,
    notifyBackground: (e: BackgroundEvent) => {
      events.push(e);
    },
    runSubAgent: async (o: SubAgentRunOptions) => {
      subAgentCalls.push(o);
      if (opts.failAgent) throw new Error('agent exploded');
      if (opts.hangAgent) {
        // A well-behaved agent checks the signal before hanging.
        if (o.signal?.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        await new Promise<void>((_, reject) => {
          o.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        });
        return;
      }
      o.onEvent({ type: 'text-delta', textDelta: 'implemented the feature' } as unknown as ChatEvent);
    },
  } as unknown as BackgroundAgentHost;
  return { host, events, dispatched, subAgentCalls };
}

async function waitForStatus(
  runId: string,
  store: FileBackgroundStateStore,
  terminal: readonly string[] = ['pr-created', 'failed', 'cancelled'],
  timeoutMs = 5000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const s = await getBackgroundStatus(runId, store);
    if (terminal.includes(s.status)) return s.status;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for terminal status (last: ${s.status})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const FIXED_NOW = '2026-10-04T00:00:00.000Z';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('background/run lifecycle', () => {
  it('returns a runId immediately and drives the run to pr-created', async () => {
    const store = makeStore();
    const { host, events, dispatched, subAgentCalls } = makeHost();
    const gitOps = makeGitOps();

    const { runId } = await startBackgroundRun(
      host,
      { goal: 'Add a health check endpoint', workspaceRoot: '/repo', now: () => FIXED_NOW, store },
      gitOps,
    );
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    const final = await waitForStatus(runId, store);
    expect(final).toBe('pr-created');

    const state = await getBackgroundStatus(runId, store);
    expect(state.branch).toMatch(/^sunday\/bg\/[0-9a-f]{8}-add-a-health-check-endpoint$/);
    expect(state.prUrl).toBe('https://github.com/acme/repo/pull/42');
    expect(state.prNumber).toBe(42);
    expect(state.createdAt).toBe(FIXED_NOW);

    // Worktree isolated on the dedicated branch.
    const add = dispatched.find((d) => d.method === 'worktree/add');
    expect(add).toBeDefined();
    expect((add!.params as { branch: string }).branch).toBe(state.branch);

    // Agent ran with the full tool catalogue, cwd confined to the worktree.
    expect(subAgentCalls).toHaveLength(1);
    expect(subAgentCalls[0].cwd).toBe(`/tmp/bg-wt/${state.branch.replace(/\//g, '-')}`);
    expect(subAgentCalls[0].tools).toBe(host.tools);

    // Git pipeline: commit → push → PR.
    expect(gitOps.calls).toEqual([
      expect.stringMatching(/^commitAll:Sunday background agent/),
      `pushBranch:${state.branch}`,
      expect.stringMatching(/^createPR:Sunday: Add a health che/),
    ]);

    // Lifecycle notifications in order.
    const phases = events.map((e) => e.phase);
    expect(phases).toEqual(['running', 'committing', 'pr-creating', 'pr-created']);
    expect(events.every((e) => e.runId === runId)).toBe(true);
  });

  it('marks the run failed when the agent throws, with the error persisted', async () => {
    const store = makeStore();
    const { host, events } = makeHost({ failAgent: true });

    const { runId } = await startBackgroundRun(
      host,
      { goal: 'Break things', workspaceRoot: '/repo', store },
      makeGitOps(),
    );
    expect(await waitForStatus(runId, store)).toBe('failed');

    const state = await getBackgroundStatus(runId, store);
    expect(state.error).toContain('agent exploded');
    expect(events.at(-1)?.phase).toBe('failed');
  });

  it('marks the run failed when PR creation fails (no silent success)', async () => {
    const store = makeStore();
    const { host } = makeHost();
    const gitOps = makeGitOps({
      createPR: async () => {
        throw new BackgroundAgentError('pr-failed', 'gh pr create failed: auth');
      },
    });

    const { runId } = await startBackgroundRun(host, { goal: 'Ship it', workspaceRoot: '/repo', store }, gitOps);
    expect(await waitForStatus(runId, store)).toBe('failed');
    const state = await getBackgroundStatus(runId, store);
    expect(state.error).toContain('gh pr create failed');
    expect(state.prUrl).toBeUndefined();
  });
});

describe('background/cancel', () => {
  it('aborts a running run, removes the worktree, and notifies', async () => {
    const store = makeStore();
    const { host, events, dispatched } = makeHost({ hangAgent: true });

    const { runId } = await startBackgroundRun(host, { goal: 'Long task', workspaceRoot: '/repo', store }, makeGitOps());
    // Wait until the agent is actually in flight.
    const start = Date.now();
    for (;;) {
      const s = await getBackgroundStatus(runId, store);
      if (s.status === 'running') break;
      if (Date.now() - start > 3000) throw new Error('run never reached running');
      await new Promise((r) => setTimeout(r, 25));
    }

    const res = await cancelBackgroundRun(host, runId, store);
    expect(res).toEqual({ cancelled: true });
    expect(await waitForStatus(runId, store)).toBe('cancelled');

    expect(dispatched.some((d) => d.method === 'worktree/remove')).toBe(true);
    expect(events.at(-1)?.phase).toBe('cancelled');
  });

  it('returns cancelled:false for an already-terminal run', async () => {
    const store = makeStore();
    const { host } = makeHost();
    const { runId } = await startBackgroundRun(host, { goal: 'Quick', workspaceRoot: '/repo', store }, makeGitOps());
    expect(await waitForStatus(runId, store)).toBe('pr-created');
    await expect(cancelBackgroundRun(host, runId, store)).resolves.toEqual({ cancelled: false });
  });

  it('throws unknown-run for a bogus id', async () => {
    const store = makeStore();
    const { host } = makeHost();
    await expect(cancelBackgroundRun(host, 'nope', store)).rejects.toMatchObject({ code: 'unknown-run' });
    await expect(getBackgroundStatus('nope', store)).rejects.toMatchObject({ code: 'unknown-run' });
  });
});

describe('background/* RPC handlers', () => {
  function table(host: BackgroundAgentHost, gitOps: GitOps) {
    return createBackgroundHandlers(host, gitOps) as Record<string, (p: unknown) => Promise<unknown>>;
  }

  it('registers exactly the three background methods', () => {
    const { host } = makeHost();
    const added = new Map<string, unknown>();
    registerBackgroundMethods({
      addMethod: (name, handler) => void added.set(name, handler),
      getBackgroundHost: () => host,
    });
    expect([...added.keys()].sort()).toEqual(['background/cancel', 'background/run', 'background/status']);
  });

  it('background/run rejects invalid params before touching any store', async () => {
    const { host } = makeHost();
    const t = table(host, makeGitOps());
    await expect(t['background/run']({ goal: '' })).rejects.toMatchObject({ code: 'invalid-params' });
    await expect(t['background/run']({})).rejects.toMatchObject({ code: 'invalid-params' });
  });

  it('background/status round-trips through the handler', async () => {
    const store = makeStore();
    const { host } = makeHost();
    const gitOps = makeGitOps();
    const { runId } = await startBackgroundRun(host, { goal: 'Do Y', workspaceRoot: '/repo', store }, gitOps);
    // The handler reads the module-level live registry populated by
    // startBackgroundRun above — no store injection needed.
    const live = createBackgroundHandlers(host, gitOps) as Record<string, (p: unknown) => Promise<unknown>>;
    const state = (await live['background/status']({ runId })) as { status: string };
    expect(['running', 'pr-created']).toContain(state.status);
  });

  it('background/cancel rejects invalid params', async () => {
    const { host } = makeHost();
    const t = table(host, makeGitOps());
    await expect(t['background/cancel']({})).rejects.toMatchObject({ code: 'invalid-params' });
    await expect(t['background/status']({ runId: 123 })).rejects.toMatchObject({ code: 'invalid-params' });
  });
});

describe('reconcileBackgroundRuns', () => {
  it('marks in-flight runs failed after a daemon restart', async () => {
    const store = makeStore();
    await store.init();
    const stuck = {
      runId: 'stuck-1',
      goal: 'Stuck',
      workspaceRoot: '/repo',
      branch: 'sunday/bg/stuck-1',
      baseBranch: 'main',
      status: 'running',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    } as const;
    await store.save({ ...stuck });
    const notified: BackgroundEvent[] = [];
    const n = await reconcileBackgroundRuns((e) => void notified.push(e), store);
    expect(n).toBe(1);
    const after = await store.load('stuck-1');
    expect(after?.status).toBe('failed');
    expect(after?.error).toContain('daemon restarted');
    expect(notified).toEqual([
      { runId: 'stuck-1', phase: 'failed', detail: 'daemon restarted while the run was in flight' },
    ]);
  });

  it('leaves terminal runs alone', async () => {
    const store = makeStore();
    await store.init();
    await store.save({
      runId: 'done-1',
      goal: 'Done',
      workspaceRoot: '/repo',
      branch: 'sunday/bg/done-1',
      baseBranch: 'main',
      status: 'pr-created',
      prUrl: 'https://github.com/a/b/pull/1',
      prNumber: 1,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await expect(reconcileBackgroundRuns(() => undefined, store)).resolves.toBe(0);
  });
});

describe('branch naming', () => {
  it('derives a slug from the goal when no title is given', async () => {
    const store = makeStore();
    const { host } = makeHost();
    const { runId } = await startBackgroundRun(
      host,
      { goal: 'Fix the login redirect!!!', workspaceRoot: '/repo', store },
      makeGitOps(),
    );
    expect(await waitForStatus(runId, store)).toBe('pr-created');
    const state = await getBackgroundStatus(runId, store);
    expect(state.branch).toMatch(/^sunday\/bg\/[0-9a-f]{8}-fix-the-login-redirect$/);
  });
});
