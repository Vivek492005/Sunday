import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  defaultOrchestrationsDir,
  setupOrchestrationPersistence,
  type OrchestrationPersistenceModule,
} from './orchestration-lifecycle.js';

/**
 * sundayd — Parallel Agents: daemon lifecycle wiring tests (Worker 2).
 * The @sunday/orchestrator module is faked: these tests pin the wiring —
 * which dir the store is constructed with, that reconcile runs on start,
 * and the degraded-mode behavior — not Worker 1's reconcile logic (covered
 * by the orchestrator package's own tests).
 */

describe('defaultOrchestrationsDir', () => {
  it('is ~/.sunday/orchestrations (same convention as sessions)', () => {
    expect(defaultOrchestrationsDir()).toBe(join(homedir(), '.sunday', 'orchestrations'));
  });
});

describe('setupOrchestrationPersistence', () => {
  /** Fake Worker-1 store: reconcile marks stale non-terminal runs interrupted. */
  function fakeModule(logs: string[]): {
    mod: OrchestrationPersistenceModule;
    runs: Map<string, { runId: string; status: string }>;
    reconciledWith: unknown[];
  } {
    const runs = new Map<string, { runId: string; status: string }>([
      ['run-stale', { runId: 'run-stale', status: 'running' }],
      ['run-done', { runId: 'run-done', status: 'done' }],
    ]);
    const reconciledWith: unknown[] = [];
    class FakeStore {
      readonly dir: string;
      constructor(dir?: string) {
        this.dir = dir ?? '';
      }
    }
    const mod: OrchestrationPersistenceModule = {
      FileOrchestrationStateStore: FakeStore,
      reconcileOrchestrationRuns: async (store: unknown) => {
        reconciledWith.push(store);
        for (const r of runs.values()) {
          if (r.status === 'running') r.status = 'interrupted';
        }
      },
    };
    void logs;
    return { mod, runs, reconciledWith };
  }

  it('constructs the store with the default dir and reconciles on start', async () => {
    const logs: string[] = [];
    const { mod, runs, reconciledWith } = fakeModule(logs);
    const store = (await setupOrchestrationPersistence(mod, (m) => logs.push(m))) as
      | { dir: string }
      | undefined;

    expect(store).toBeDefined();
    // Constructed with ~/.sunday/orchestrations.
    expect(store?.dir).toBe(join(homedir(), '.sunday', 'orchestrations'));
    expect(reconciledWith).toHaveLength(1);
    expect(reconciledWith[0]).toBe(store);
    // Contract semantics: stale non-terminal runs become interrupted.
    expect(runs.get('run-stale')?.status).toBe('interrupted');
    expect(runs.get('run-done')?.status).toBe('done');
    // The outcome is logged (stderr — stdout stays clean for NDJSON).
    expect(logs.some((m) => m.includes('reconciled'))).toBe(true);
    expect(logs.some((m) => m.includes(join(homedir(), '.sunday', 'orchestrations')))).toBe(true);
  });

  it('degrades gracefully when the orchestrator predates the parallel phase', async () => {
    const logs: string[] = [];
    const store = await setupOrchestrationPersistence({}, (m) => logs.push(m));
    expect(store).toBeUndefined();
    expect(logs.some((m) => m.includes('unavailable'))).toBe(true);
  });

  it('degrades gracefully when reconcile throws (daemon still starts)', async () => {
    const logs: string[] = [];
    const mod: OrchestrationPersistenceModule = {
      FileOrchestrationStateStore: class {},
      reconcileOrchestrationRuns: async () => {
        throw new Error('disk on fire');
      },
    };
    const store = await setupOrchestrationPersistence(mod, (m) => logs.push(m));
    expect(store).toBeUndefined();
    expect(logs.some((m) => m.includes('reconcile failed'))).toBe(true);
  });

  it('uses console.error by default', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await setupOrchestrationPersistence({});
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});
