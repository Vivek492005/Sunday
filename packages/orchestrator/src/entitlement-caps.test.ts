/**
 * @sunday/orchestrator — Task 7 entitlement-cap tests.
 *
 * Pure `applyEntitlementCaps` math plus integration through
 * `runOrchestration` with a scripted mock host: the cap note lands on the
 * plan artifact, the pool never exceeds the entitlement, and parallel mode
 * is forced off when the plan denies it. No real models, no real git.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@sunday/tools';
import type { ChatEvent } from '@sunday/protocol';
import {
  applyEntitlementCaps,
  runOrchestration,
  FileOrchestrationStateStore,
  DEFAULT_RUNNER_MAX_PARALLEL,
} from './runner.js';
import type { OrchestratorHost, SubAgentRunOptions } from './host.js';
import type { OrchestrationEvent, PlannedUnit } from './schemas.js';

function unit(id: string, owns: string[]): PlannedUnit {
  return { id, title: `unit ${id}`, owns_paths: owns, acceptance: ['it works'], budget: 5 };
}

interface MockHost {
  host: OrchestratorHost;
  events: OrchestrationEvent[];
  maxActive: () => number;
}

function createMockHost(): MockHost {
  const events: OrchestrationEvent[] = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sun-cap-'));
  const tools = new ToolRegistry();
  tools.register({
    definition: {
      name: 'git_diff',
      description: 'fake git diff',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    async execute() {
      return { output: '(no diff)' };
    },
  });
  let active = 0;
  let peak = 0;
  const host: OrchestratorHost = {
    router: {} as OrchestratorHost['router'],
    tools,
    defaultModel: 'test-model',
    async dispatch(method: string, params: unknown): Promise<unknown> {
      const p = params as Record<string, string>;
      if (method === 'worktree/add') {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'wt-'));
        return { path: dir, branch: p['branch'] };
      }
      if (method === 'worktree/merge') return { merged: true, sha: `sha-${p['path']}`, target: 'main' };
      if (method === 'worktree/remove') return { removed: true };
      if (method === 'checkpoint/create') {
        return { id: 'cp-1', sha: 'abc', createdAt: new Date().toISOString() };
      }
      throw new Error(`unexpected dispatch: ${method}`);
    },
    notify(event: OrchestrationEvent): void {
      events.push(event);
    },
    async runSubAgent(o: SubAgentRunOptions): Promise<void> {
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (o.title.startsWith('SUNDAY verifier:')) {
          o.onEvent({
            type: 'text-delta',
            delta: JSON.stringify({ verdict: 'pass', evidence: 'all criteria met' }),
          } as ChatEvent);
        }
        o.onEvent({ type: 'turn-end', finishReason: 'stop' } as ChatEvent);
      } finally {
        active -= 1;
      }
    },
  };
  return { host, events, maxActive: () => peak };
}

function tempStore(): FileOrchestrationStateStore {
  return new FileOrchestrationStateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sun-cap-store-')));
}

const GOAL = 'cap the agents';
const ROOT = '/tmp/sun-test-workspace';

function plannedDetail(events: OrchestrationEvent[]): string {
  const e = events.find((ev) => ev.phase === 'planned');
  return e?.detail ?? '';
}

describe('applyEntitlementCaps', () => {
  it('fails open when caps are absent', () => {
    expect(applyEntitlementCaps({ parallel: true, maxParallel: 4 }, undefined)).toEqual({
      parallel: true,
      maxParallel: 4,
    });
    expect(applyEntitlementCaps({ parallel: false }, undefined).maxParallel).toBe(
      DEFAULT_RUNNER_MAX_PARALLEL,
    );
  });

  it('clamps the pool to maxFeatureAgents and notes the cap', () => {
    const r = applyEntitlementCaps(
      { parallel: true, maxParallel: 4 },
      { maxFeatureAgents: 2, parallelAllowed: true },
    );
    expect(r).toEqual({
      parallel: true,
      maxParallel: 2,
      capNote: 'Capped at 2 agents on your plan',
    });
  });

  it('forces parallel off when the plan denies it', () => {
    const r = applyEntitlementCaps(
      { parallel: true, maxParallel: 3 },
      { maxFeatureAgents: 3, parallelAllowed: false },
    );
    expect(r.parallel).toBe(false);
    expect(r.maxParallel).toBe(3);
    expect(r.capNote).toBeUndefined();
  });

  it('adds no note when nothing is capped', () => {
    const r = applyEntitlementCaps(
      { parallel: true, maxParallel: 2 },
      { maxFeatureAgents: 4, parallelAllowed: true },
    );
    expect(r).toEqual({ parallel: true, maxParallel: 2, capNote: undefined });
  });

  it('floors degenerate caps at one agent', () => {
    const r = applyEntitlementCaps(
      { parallel: true, maxParallel: 0 },
      { maxFeatureAgents: 0, parallelAllowed: true },
    );
    expect(r.maxParallel).toBe(1);
  });
});

describe('runOrchestration entitlement enforcement', () => {
  it('caps the parallel pool and notes it on the plan artifact', async () => {
    const m = createMockHost();
    const plan = {
      units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**']), unit('u3', ['src/c/**'])],
    };
    const result = await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      maxParallel: 4,
      entitlementCaps: { maxFeatureAgents: 2, parallelAllowed: true },
      store: tempStore(),
    });
    expect(result.units.map((u) => u.status)).toEqual(['merged', 'merged', 'merged']);
    expect(m.maxActive()).toBeLessThanOrEqual(2);
    const detail = plannedDetail(m.events);
    expect(detail).toContain('pool of 2');
    expect(detail).toContain('Capped at 2 agents on your plan');
  });

  it('forces sequential mode when parallelAllowed is false', async () => {
    const m = createMockHost();
    const plan = { units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**'])] };
    const result = await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      maxParallel: 3,
      entitlementCaps: { maxFeatureAgents: 1, parallelAllowed: false },
      store: tempStore(),
    });
    expect(result.units.map((u) => u.status)).toEqual(['merged', 'merged']);
    // Sequential path: never more than one agent in flight.
    expect(m.maxActive()).toBe(1);
    // No parallel-mode plan artifact.
    expect(plannedDetail(m.events)).not.toContain('parallel mode');
  });

  it('runs uncapped when caps are absent (fail open)', async () => {
    const m = createMockHost();
    const plan = { units: [unit('u1', ['src/a/**']), unit('u2', ['src/b/**'])] };
    const result = await runOrchestration(m.host, {
      goal: GOAL,
      workspaceRoot: ROOT,
      plan,
      parallel: true,
      store: tempStore(),
    });
    expect(result.units.map((u) => u.status)).toEqual(['merged', 'merged']);
    expect(plannedDetail(m.events)).toContain('parallel mode');
    expect(plannedDetail(m.events)).not.toContain('Capped at');
  });
});
