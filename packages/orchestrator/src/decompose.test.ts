// @sunday/orchestrator — vitest for decompose.ts (one-prompt swarm, F3).
// No real LLM calls: the mock host drives planGoal over MockChatProvider
// with a canned planner-JSON script, following the pattern from
// packages/sundayd/src/orchestration-integration.test.ts.
import { describe, expect, it } from 'vitest';
import { MockChatProvider, ProviderRegistry, Router } from '@sunday/gateway';
import type { ChatChunk } from '@sunday/gateway';
import { ToolRegistry } from '@sunday/tools';
import type { OrchestratorHost } from './host.js';
import { decompose, summarizePlan } from './decompose.js';
import type { OrchestrationPlan } from './schemas.js';

function textDone(text: string): ChatChunk[] {
  return [
    { type: 'text-delta', delta: text },
    { type: 'done', finishReason: 'stop' },
  ];
}

/** Minimal mock host: scripted gateway, empty tool catalogue, no daemon. */
function makeHost(scripts: ChatChunk[][]): OrchestratorHost {
  const provider = new MockChatProvider({ id: 'mock', scripts });
  const providers = new ProviderRegistry();
  providers.register(provider);
  return {
    router: new Router(providers, 'mock:mock-model'),
    tools: new ToolRegistry(),
    defaultModel: 'mock:mock-model',
    dispatch: async () => {
      throw new Error('dispatch not used by the planner');
    },
    notify: () => {},
    runSubAgent: async () => {
      throw new Error('runSubAgent not used by the planner');
    },
  };
}

function cannedPlanJson(): string {
  return JSON.stringify({
    units: [
      {
        id: 'auth',
        title: 'Add login flow',
        owns_paths: ['src/auth/**'],
        acceptance: ['pnpm test passes'],
        budget: 20,
      },
      {
        id: 'search',
        title: 'Add search box',
        owns_paths: ['src/search/**'],
        acceptance: ['pnpm test passes'],
        budget: 10,
      },
    ],
  });
}

describe('decompose', () => {
  it('wraps planGoal and returns the validated plan', async () => {
    const plan = await decompose({
      goal: 'add auth and search',
      workspaceRoot: '/repo',
      host: makeHost([textDone(cannedPlanJson())]),
    });
    expect(plan.units).toHaveLength(2);
    expect(plan.units[0].id).toBe('auth');
    expect(plan.units[1].id).toBe('search');
    // ADR-18: sum(budgets) + one verification pass per unit + the planner call.
    expect(plan.totalBudget).toBe(20 + 10 + 2 + 1);
  });

  it('propagates planner errors without a real model', async () => {
    await expect(
      decompose({
        goal: 'do things',
        workspaceRoot: '/repo',
        host: makeHost([textDone('no json here, just prose')]),
      }),
    ).rejects.toMatchObject({ code: 'plan-invalid' });
  });

  it('rejects a plan whose units overlap', async () => {
    await expect(
      decompose({
        goal: 'overlap',
        workspaceRoot: '/repo',
        host: makeHost([
          textDone(
            JSON.stringify({
              units: [
                { id: 'a', title: 'A', owns_paths: ['src/**'], acceptance: ['x'], budget: 5 },
                { id: 'b', title: 'B', owns_paths: ['src/a/**'], acceptance: ['x'], budget: 5 },
              ],
            }),
          ),
        ]),
      }),
    ).rejects.toMatchObject({ code: 'plan-overlap' });
  });

  it('honours abort', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      decompose({
        goal: 'cancelled',
        workspaceRoot: '/repo',
        signal: controller.signal,
        host: makeHost([textDone(cannedPlanJson())]),
      }),
    ).rejects.toThrow();
  });
});

describe('summarizePlan', () => {
  const plan: OrchestrationPlan = {
    units: [
      {
        id: 'auth',
        title: 'Add login flow',
        owns_paths: ['src/auth/**'],
        acceptance: ['pnpm test passes'],
        budget: 20,
      },
      {
        id: 'search',
        title: 'Add search box',
        owns_paths: ['src/search/**'],
        acceptance: ['pnpm test passes'],
        budget: 10,
      },
    ],
    totalBudget: 33,
  };

  it('renders a human-readable multi-line summary', () => {
    const summary = summarizePlan(plan);
    expect(summary).toContain('2 unit(s)');
    expect(summary).toContain('total budget 33');
    expect(summary).toContain('[auth]');
    expect(summary).toContain('Add login flow');
    expect(summary).toContain('budget: 20');
    expect(summary).toContain('[search]');
    expect(summary).toContain('Add search box');
    expect(summary).toContain('budget: 10');
  });

  it('places one unit per line', () => {
    const lines = summarizePlan(plan).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^\-\s*\[auth\]/);
    expect(lines[2]).toMatch(/^\-\s*\[search\]/);
  });
});
