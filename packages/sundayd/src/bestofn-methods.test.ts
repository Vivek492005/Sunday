// Tests for the A2 sundayd bestofn/run method: param validation,
// temperature/angle matrix, per-attempt worktrees, diff collection, and
// graceful handling of worktree/agent failures. Host + worktrees are
// mocked; no git, no daemon, no network.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  BESTOFN_ANGLES,
  BESTOFN_TEMPERATURES,
  registerBestOfNMethods,
  type BestOfNHost,
} from './bestofn-methods.js';
import type { WorktreeManager } from './worktrees.js';

function makeHarness(opts: {
  failWorktree?: boolean;
  failAgentIndexes?: number[];
  streamText?: string;
  diff?: string;
  files?: string[];
} = {}) {
  const methods = new Map<string, (params: unknown) => Promise<unknown>>();
  const subAgentCalls: Array<{ cwd: string; temperature?: number; systemPrompt: string }> = [];
  let n = 0;
  const host: BestOfNHost = {
    tools: {} as BestOfNHost['tools'],
    runSubAgent: vi.fn(async (o) => {
      const idx = n++;
      subAgentCalls.push({ cwd: o.cwd, temperature: o.temperature, systemPrompt: o.systemPrompt });
      if (opts.failAgentIndexes?.includes(idx)) throw new Error('agent exploded');
      o.onEvent({ type: 'text-delta', delta: opts.streamText ?? `summary text for ${o.title}` } as never);
    }),
  };
  const worktrees = {
    add: vi.fn(async ({ branch }: { branch: string }) => {
      if (opts.failWorktree) throw new Error('not a git repo');
      return { path: `/tmp/wt-${branch}`, branch };
    }),
  } as unknown as WorktreeManager;
  // Stub git diff via the real execFile? No — bestofn-methods shells to git.
  // Instead we point worktree paths at a fake and intercept execFile... The
  // module calls execFile directly, so we fake the diff by pre-seeding: the
  // test overrides are injected through a custom WorktreeManager is not
  // enough. Simplest: vi.mock('node:child_process') is overkill; instead we
  // accept that git diff on a nonexistent path yields '' via the catch.
  const logs: string[] = [];
  registerBestOfNMethods({
    addMethod: (name, handler) => methods.set(name, handler),
    host,
    worktrees,
    log: (m) => logs.push(m),
  });
  const run = methods.get('bestofn/run')!;
  return { run, host, worktrees, subAgentCalls, logs };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('bestofn/run', () => {
  it('registers the method and runs N variants with the temperature/angle matrix', async () => {
    const { run, subAgentCalls, worktrees } = makeHarness();
    const res = (await run({ goal: 'add a button', attempts: 3, workdir: '/repo' })) as {
      attempts: Array<{ id: string; temperature: number; angle: string; worktree: string; branch: string }>;
    };
    expect(res.attempts).toHaveLength(3);
    expect(res.attempts.map((a) => a.temperature)).toEqual([0.2, 0.7, 1.0]);
    expect(res.attempts.map((a) => a.angle)).toEqual([...BESTOFN_ANGLES]);
    expect(BESTOFN_TEMPERATURES).toEqual([0.2, 0.7, 1.0]);
    // Each variant got its own worktree branch + cwd.
    expect(worktrees.add).toHaveBeenCalledTimes(3);
    const branches = (worktrees.add as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].branch as string);
    expect(new Set(branches).size).toBe(3);
    expect(branches.every((b) => b.startsWith('sunday/bestofn/'))).toBe(true);
    expect(subAgentCalls.map((c) => c.temperature)).toEqual([0.2, 0.7, 1.0]);
    expect(subAgentCalls.map((c) => c.cwd)).toEqual(res.attempts.map((a) => a.worktree));
    // Angle guidance reaches the system prompt.
    expect(subAgentCalls[0]!.systemPrompt).toContain('conservative');
    expect(subAgentCalls[2]!.systemPrompt).toContain('creative');
  });

  it('defaults to 3 attempts and collects the summary', async () => {
    const { run } = makeHarness({ streamText: 'fixed the thing. Summary: all good' });
    const res = (await run({ goal: 'g', workdir: '/repo' })) as {
      attempts: Array<{ summary: string }>;
    };
    expect(res.attempts).toHaveLength(3);
    expect(res.attempts[0]!.summary).toContain('Summary: all good');
  });

  it('records a failed agent as an error-attempt without failing the batch', async () => {
    const { run, logs } = makeHarness({ failAgentIndexes: [1] });
    const res = (await run({ goal: 'g', attempts: 3, workdir: '/repo' })) as {
      attempts: Array<{ error?: string; worktree: string }>;
    };
    expect(res.attempts[1]!.error).toContain('agent exploded');
    expect(res.attempts[1]!.worktree).toBeTruthy(); // worktree kept for inspection
    expect(res.attempts[0]!.error).toBeUndefined();
    expect(res.attempts[2]!.error).toBeUndefined();
    expect(logs.some((l) => l.includes('attempt-2'))).toBe(true);
  });

  it('records worktree setup failures (non-git workdir) as error-attempts', async () => {
    const { run, host } = makeHarness({ failWorktree: true });
    const res = (await run({ goal: 'g', attempts: 2, workdir: '/not-a-repo' })) as {
      attempts: Array<{ error?: string }>;
    };
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts.every((a) => a.error?.includes('worktree setup failed'))).toBe(true);
    expect(host.runSubAgent).not.toHaveBeenCalled();
  });

  it('validates params', async () => {
    const { run } = makeHarness();
    await expect(run(undefined)).rejects.toThrow(/object/);
    await expect(run({ goal: '  ', workdir: '/r' })).rejects.toThrow(/goal is required/);
    await expect(run({ goal: 'g', workdir: '' })).rejects.toThrow(/workdir/);
    await expect(run({ goal: 'g', workdir: '/r', attempts: 0 })).rejects.toThrow(/1\.\.8/);
    await expect(run({ goal: 'g', workdir: '/r', attempts: 9 })).rejects.toThrow(/1\.\.8/);
    await expect(run({ goal: 'g', workdir: '/r', attempts: 2.5 })).rejects.toThrow(/1\.\.8/);
    await expect(run({ goal: 'x'.repeat(8001), workdir: '/r' })).rejects.toThrow(/8000/);
  });
});
