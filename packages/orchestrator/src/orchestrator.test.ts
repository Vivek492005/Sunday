import { describe, expect, it } from 'vitest';
import { MockChatProvider } from '@sunday/gateway';
import type { ChatChunk, ChatRequest } from '@sunday/gateway';
import { createDefaultRegistry } from '@sunday/tools';
import type { ChatEvent } from '@sunday/protocol';
import { AgentLoop, SessionStore, newTurnId } from '@sunday/sundayd';
import { Router, ProviderRegistry } from '@sunday/gateway';
import { OrchestrationError } from './errors.js';
import type { OrchestratorHost, SubAgentRunOptions } from './host.js';
import { registerOrchestrationMethods } from './host.js';
import { createOrchestrationHandlers } from './handlers.js';
import { planGoal, estimateTotalBudget } from './planner.js';
import { runOrchestration } from './runner.js';
import { globsOverlap, findOverlaps, checkUnitsOverlap } from './overlap.js';
import { validatePlanUnits } from './planner.js';
import {
  ORCHESTRATOR_TOOL_NAMES,
  VERIFIER_TOOL_NAMES,
  scopedToolDefinitions,
  scopedRegistry,
} from './toolscope.js';
import type { OrchestrationEvent, PlannedUnit } from './schemas.js';

/* ------------------------------------------------------------------ */
/* Fakes: a fake gateway (no network, no keys), a fake daemon dispatch for the
   worktree and checkpoint primitives, and an event recorder. */
/* ------------------------------------------------------------------ */

function textDone(text: string): ChatChunk[] {
  return [
    { type: 'text-delta', delta: text },
    { type: 'done', finishReason: 'stop' },
  ];
}

class RecordingProvider extends MockChatProvider {
  readonly seen: ChatRequest[] = [];
  constructor(scripts: ChatChunk[][]) {
    super({ id: 'mock', scripts });
  }
  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.seen.push(req);
    yield* super.chat(req);
  }
}

interface FakeDispatchCall {
  method: string;
  params: unknown;
}

function makeHost(scripts: ChatChunk[][]): {
  host: OrchestratorHost;
  provider: RecordingProvider;
  dispatchCalls: FakeDispatchCall[];
  events: OrchestrationEvent[];
} {
  const provider = new RecordingProvider(scripts);
  const providers = new ProviderRegistry();
  providers.register(provider);
  const router = new Router(providers, 'mock:mock-model');
  const sessions = new SessionStore('/tmp/sunday-orchestrator-test-sessions');
  const dispatchCalls: FakeDispatchCall[] = [];
  const events: OrchestrationEvent[] = [];
  const host: OrchestratorHost = {
    router,
    tools: createDefaultRegistry(),
    defaultModel: 'mock:mock-model',
    dispatch: async (method: string, params: unknown) => {
      dispatchCalls.push({ method, params });
      const p = params as Record<string, string>;
      switch (method) {
        case 'worktree/add':
          return { path: `/tmp/wt/${String(p['branch']).replace(/\//g, '-')}`, branch: p['branch'] };
        case 'worktree/merge':
          return { merged: true, sha: 'deadbeef', target: 'main' };
        case 'worktree/remove':
          return { removed: true };
        case 'checkpoint/create':
          return { id: 'ckpt-1', sha: 'deadbeef', createdAt: '2026-10-01T00:00:00.000Z' };
        default:
          throw new Error(`unexpected dispatch: ${method}`);
      }
    },
    notify: (event: OrchestrationEvent) => {
      events.push(event);
    },
    // Test executor: drives the REAL AgentLoop over the mock provider, so all
    // provider-scripted scenarios (pass/fail/retry) behave exactly as before
    // the inversion — only the loop construction site moved (daemon in prod).
    runSubAgent: async (opts: SubAgentRunOptions) => {
      const session = sessions.create({ title: opts.title, cwd: opts.cwd, model: opts.model });
      session.messages.push({ role: 'system', content: opts.systemPrompt });
      const loop = new AgentLoop(
        { tools: opts.tools, providers },
        { event: (_sid: string, _tid: string, event: ChatEvent) => opts.onEvent(event) },
        { router, maxIterations: opts.maxIterations },
      );
      await loop.runTurn(newTurnId(), session, opts.prompt, {
        model: opts.model,
        signal: opts.signal,
      });
    },
  };
  return { host, provider, dispatchCalls, events };
}

function unit(id: string, owns: string[]): PlannedUnit {
  return {
    id,
    title: `Unit ${id}`,
    owns_paths: owns,
    acceptance: ['pnpm test passes with 0 failures', 'negative test: bad input is rejected'],
    budget: 6,
  };
}

/* ------------------------------------------------------------------ */
/* 1. Static owns_paths overlap check (§9.9.6)                          */
/* ------------------------------------------------------------------ */

describe('globsOverlap', () => {
  it('detects a parent glob overlapping a child glob', () => {
    expect(globsOverlap('src/**', 'src/a/**')).toBe(true);
    expect(globsOverlap('src/a/**', 'src/**')).toBe(true);
  });

  it('detects an exact file inside an owned tree', () => {
    expect(globsOverlap('src/a/**', 'src/a/b.ts')).toBe(true);
  });

  it('does not flag sibling trees as overlapping', () => {
    expect(globsOverlap('src/a/**', 'src/b/**')).toBe(false);
  });

  it('is segment-aware: src/ab/** does not overlap src/a/**', () => {
    expect(globsOverlap('src/ab/**', 'src/a/**')).toBe(false);
  });

  it('treats a bare ** as overlapping everything', () => {
    expect(globsOverlap('**/*.ts', 'src/a/**')).toBe(true);
  });

  it('requires identical paths for two exact files', () => {
    expect(globsOverlap('src/a.ts', 'src/a.ts')).toBe(true);
    expect(globsOverlap('src/a.ts', 'src/b.ts')).toBe(false);
  });
});

describe('plan overlap validation', () => {
  it('throws plan-overlap when two units own intersecting paths', () => {
    expect(() =>
      validatePlanUnits({ units: [unit('u1', ['src/a/**']), unit('u2', ['src/**'])] }),
    ).toThrowError(OrchestrationError);
    try {
      validatePlanUnits({ units: [unit('u1', ['src/a/**']), unit('u2', ['src/**'])] });
    } catch (e) {
      expect((e as OrchestrationError).code).toBe('plan-overlap');
    }
  });

  it('findOverlaps names the offending pair', () => {
    const pairs = findOverlaps([unit('u1', ['src/a/**']), unit('u2', ['src/**'])]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].unitA).toBe('u1');
    expect(pairs[0].unitB).toBe('u2');
  });

  it('accepts disjoint owns_paths', () => {
    expect(() =>
      checkUnitsOverlap([unit('u1', ['src/a/**']), unit('u2', ['src/b/**'])]),
    ).not.toThrow();
  });

  it('rejects more than 8 units', () => {
    const units = Array.from({ length: 9 }, (_, i) => unit(`u${i}`, [`src/mod${i}/**`]));
    try {
      validatePlanUnits({ units });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as OrchestrationError).code).toBe('too-many-units');
    }
  });

  it('rejects duplicate unit ids', () => {
    try {
      validatePlanUnits({ units: [unit('u1', ['src/a/**']), unit('u1', ['src/b/**'])] });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as OrchestrationError).code).toBe('plan-invalid');
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Planner: model-driven decomposition + ADR-18 budget               */
/* ------------------------------------------------------------------ */

describe('planGoal', () => {
  it('parses the planner JSON and surfaces the budget before delegation', async () => {
    const { host } = makeHost([
      textDone(
        JSON.stringify({
          units: [
            { id: 'auth', title: 'Auth flow', owns_paths: ['src/auth/**'], acceptance: ['pnpm test passes'], budget: 20 },
            { id: 'search', title: 'Search', owns_paths: ['src/search/**'], acceptance: ['pnpm test passes'], budget: 10 },
          ],
        }),
      ),
    ]);
    const plan = await planGoal(host, { goal: 'add auth and search', workspaceRoot: '/repo', model: 'mock:mock-model' });
    expect(plan.units).toHaveLength(2);
    expect(plan.units[0].id).toBe('auth');
    // ADR-18: sum(budgets) + one verification per unit + the planner call.
    expect(plan.totalBudget).toBe(20 + 10 + 2 + 1);
    expect(estimateTotalBudget(plan.units)).toBe(plan.totalBudget);
  });

  it('rejects a plan whose owns_paths overlap', async () => {
    const { host } = makeHost([
      textDone(
        JSON.stringify({
          units: [
            { id: 'a', title: 'A', owns_paths: ['src/**'], acceptance: ['x'], budget: 5 },
            { id: 'b', title: 'B', owns_paths: ['src/a/**'], acceptance: ['x'], budget: 5 },
          ],
        }),
      ),
    ]);
    await expect(planGoal(host, { goal: 'g', workspaceRoot: '/repo', model: 'mock:mock-model' })).rejects.toMatchObject({
      code: 'plan-overlap',
    });
  });

  it('rejects non-JSON planner output', async () => {
    const { host } = makeHost([textDone('Sure, here is my plan in prose...')]);
    await expect(planGoal(host, { goal: 'g', workspaceRoot: '/repo', model: 'mock:mock-model' })).rejects.toMatchObject({
      code: 'plan-invalid',
    });
  });

  it('never hands the planner a write/exec tool', async () => {
    const { host, provider } = makeHost([
      textDone(
        JSON.stringify({
          units: [{ id: 'a', title: 'A', owns_paths: ['x/**'], acceptance: ['y'], budget: 5 }],
        }),
      ),
    ]);
    await planGoal(host, { goal: 'g', workspaceRoot: '/repo', model: 'mock:mock-model' });
    const toolNames = (provider.seen[0].tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain('write_file');
    expect(toolNames).not.toContain('edit_file');
    expect(toolNames).not.toContain('run_terminal');
  });
});

/* ------------------------------------------------------------------ */
/* 3. Orchestrator tool scoping — enforced by construction              */
/* ------------------------------------------------------------------ */

describe('tool scoping', () => {
  const registry = createDefaultRegistry();

  it('ORCHESTRATOR_TOOL_NAMES excludes every write/exec tool', () => {
    expect(ORCHESTRATOR_TOOL_NAMES).not.toContain('write_file');
    expect(ORCHESTRATOR_TOOL_NAMES).not.toContain('edit_file');
    expect(ORCHESTRATOR_TOOL_NAMES).not.toContain('run_terminal');
    expect(ORCHESTRATOR_TOOL_NAMES).toContain('read_file');
    expect(ORCHESTRATOR_TOOL_NAMES).toContain('search');
  });

  it('scopedToolDefinitions never yields a write tool', () => {
    const defs = scopedToolDefinitions(registry, ORCHESTRATOR_TOOL_NAMES);
    const names = defs.map((d) => d.name);
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('run_terminal');
    expect(names.length).toBeGreaterThan(0);
  });

  it('the verifier registry physically cannot run write tools', async () => {
    const v = scopedRegistry(registry, VERIFIER_TOOL_NAMES);
    expect(v.names()).not.toContain('write_file');
    expect(v.names()).not.toContain('run_terminal');
    const r = await v.call('write_file', { path: 'x', content: 'y' }, { cwd: '/tmp' });
    expect(r.isError).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Sequential runner: pass→merge, fail→retry→fail→continue (ADR-17)  */
/* ------------------------------------------------------------------ */

const PASS = JSON.stringify({ verdict: 'pass', evidence: 'full suite green, negative test red as expected' });
const FAIL = (n: number) =>
  JSON.stringify({ verdict: 'fail', evidence: `suite red on attempt ${n}`, failing_criterion: 'pnpm test passes with 0 failures' });

describe('runOrchestration (sequential v1)', () => {
  it('merges the passing unit, retries the failing one twice, then continues', async () => {
    const { host, dispatchCalls, events, provider } = makeHost([
      textDone('FEATURE-AGENT-SECRET-U1\nImplemented unit u1.'),
      textDone(PASS),
      textDone('FEATURE-AGENT-SECRET-U2\nImplemented unit u2.'),
      textDone(FAIL(1)),
      textDone('fixed attempt 2'),
      textDone(FAIL(2)),
      textDone('fixed attempt 3'),
      textDone(FAIL(3)),
    ]);
    const plan = { units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**'])] };

    const result = await runOrchestration(host, {
      goal: 'two units',
      workspaceRoot: '/repo',
      model: 'mock:mock-model',
      plan,
    });

    // Per-unit outcomes: merged + failed, and the run continued past u2's failure.
    expect(result.units).toEqual([
      { id: 'u1', status: 'merged', sha: 'deadbeef' },
      { id: 'u2', status: 'failed' },
    ]);
    expect(result.mergedSha).toBe('deadbeef');

    // Strictly sequential dispatch: u1 fully done (add→merge→checkpoint)
    // before u2's worktree is even created; u2's worktree is removed after
    // its retries are exhausted.
    const methods = dispatchCalls.map((c) => c.method);
    expect(methods).toEqual([
      'worktree/add',
      'worktree/merge',
      'checkpoint/create',
      'worktree/add',
      'worktree/remove',
    ]);
    expect((dispatchCalls[0].params as Record<string, string>)['branch']).toBe('sunday/feat/u1');
    expect((dispatchCalls[3].params as Record<string, string>)['branch']).toBe('sunday/feat/u2');

    // Progress events: budget surfaced first, then the phase lifecycle.
    expect(events[0].phase).toBe('planned');
    expect(events[0].detail).toContain('~');
    const phases = events.map((e) => `${e.unitId}:${e.phase}`);
    expect(phases[0]).toBe(':planned');
    expect(phases).toContain('u1:started');
    expect(phases).toContain('u1:verifying');
    expect(phases).toContain('u1:merged');
    expect(phases).toContain('u2:failed');
    // u2: initial + 2 FIXING retries = 3 started phases before failed.
    expect(phases.filter((p) => p === 'u2:started')).toHaveLength(3);

    // The feature agent gets the FULL tool catalogue (it is the only writer).
    const featureTools = (provider.seen[0].tools ?? []).map((t) => t.name);
    expect(featureTools).toContain('write_file');
    expect(featureTools).toContain('run_terminal');

    // ADR-16: the verifier's request carries the diff + acceptance criteria
    // but NEVER the feature agent's history (its secret summary is absent).
    const verifierReq = provider.seen[1];
    const verifierText = verifierReq.messages.map((m) => JSON.stringify(m)).join('\n');
    expect(verifierText).toContain('pnpm test passes with 0 failures');
    expect(verifierText).not.toContain('FEATURE-AGENT-SECRET-U1');
    // ...and the verifier is only offered read-only tools.
    const verifierTools = (verifierReq.tools ?? []).map((t) => t.name);
    expect(verifierTools).not.toContain('write_file');
    expect(verifierTools).not.toContain('edit_file');
    expect(verifierTools).not.toContain('run_terminal');

    // Every verifier attempt is a FRESH session (6 feature/verifier sessions
    // total here: feat u1, ver u1, feat u2 ×3, ver u2 ×3 → 8 chat calls).
    expect(provider.seen).toHaveLength(8);
  });

  it('re-validates a caller-supplied plan (overlap is rejected)', async () => {
    const { host } = makeHost([]);
    await expect(
      runOrchestration(host, {
        goal: 'g',
        workspaceRoot: '/repo',
        model: 'mock:mock-model',
        plan: { units: [unit('u1', ['src/**']), unit('u2', ['src/a/**'])] },
      }),
    ).rejects.toMatchObject({ code: 'plan-overlap' });
  });

  it('returns an empty merge result when nothing merged', async () => {
    const { host } = makeHost([
      textDone('did stuff'),
      textDone(FAIL(1)),
      textDone('retry 1'),
      textDone(FAIL(2)),
      textDone('retry 2'),
      textDone(FAIL(3)),
    ]);
    const result = await runOrchestration(host, {
      goal: 'g',
      workspaceRoot: '/repo',
      model: 'mock:mock-model',
      plan: { units: [unit('u1', ['src/a/**'])] },
    });
    expect(result.units).toEqual([{ id: 'u1', status: 'failed' }]);
    expect(result.mergedSha).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 5. Daemon wiring: registerOrchestrationMethods                      */
/* ------------------------------------------------------------------ */

describe('registerOrchestrationMethods', () => {
  it('registers orchestrate/plan and orchestrate/run on the daemon', async () => {
    const { host } = makeHost([
      textDone(JSON.stringify({ units: [{ id: 'a', title: 'A', owns_paths: ['x/**'], acceptance: ['y'], budget: 5 }] })),
    ]);
    const registered = new Map<string, (params: unknown) => Promise<unknown>>();
    registerOrchestrationMethods({
      addMethod: (name, handler) => {
        registered.set(name, handler);
      },
      getOrchestratorHost: () => host,
    });
    expect([...registered.keys()].sort()).toEqual(['orchestrate/plan', 'orchestrate/run']);

    const plan = (await registered.get('orchestrate/plan')!({
      goal: 'g',
      workspaceRoot: '/repo',
      model: 'mock:mock-model',
    })) as { units: unknown[]; totalBudget: number };
    expect(plan.units).toHaveLength(1);
    expect(plan.totalBudget).toBe(5 + 1 + 1);
  });

  it('createOrchestrationHandlers validates params before dispatching', async () => {
    const { host } = makeHost([]);
    const handlers = createOrchestrationHandlers(host);
    await expect(handlers['orchestrate/plan']({ goal: '' })).rejects.toMatchObject({
      code: 'invalid-params',
    });
    await expect(handlers['orchestrate/run']({})).rejects.toMatchObject({
      code: 'invalid-params',
    });
  });
});
