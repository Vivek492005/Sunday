/**
 * @sunday/orchestrator — FileOrchestrationStateStore tests. Always a temp
 * dir; never the real ~/.sunday.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileOrchestrationStateStore,
  defaultOrchestrationsDir,
  reconcileOrchestrationRuns,
} from './state.js';
import type { OrchestrationRunState } from './schemas.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sun-state-'));
}

function runState(partial: Partial<OrchestrationRunState> = {}): OrchestrationRunState {
  return {
    runId: 'run-123',
    goal: 'test goal',
    parallel: true,
    status: 'running',
    units: [
      { id: 'u1', title: 'unit one', status: 'running', worktreePath: '/tmp/wt-u1' },
      { id: 'u2', title: 'unit two', status: 'queued' },
    ],
    conflicts: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

describe('FileOrchestrationStateStore', () => {
  it('round-trips a run through save/load', async () => {
    const store = new FileOrchestrationStateStore(tempDir());
    await store.init();
    const s = runState();
    await store.save(s);
    expect(await store.load('run-123')).toEqual(s);
  });

  it('init creates the directory and sweeps stale tmp files', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'sub');
    const store = new FileOrchestrationStateStore(target);
    await store.init();
    expect(fs.statSync(target).isDirectory()).toBe(true);
    fs.writeFileSync(path.join(target, 'orphan.1.tmp'), 'x');
    await store.init();
    expect(fs.existsSync(path.join(target, 'orphan.1.tmp'))).toBe(false);
  });

  it('list skips corrupt files instead of throwing', async () => {
    const dir = tempDir();
    const store = new FileOrchestrationStateStore(dir);
    await store.init();
    await store.save(runState({ runId: 'good' }));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    const listed = await store.list();
    expect(listed.map((s) => s.runId)).toEqual(['good']);
  });

  it('load returns undefined for missing runs and unsafe ids', async () => {
    const store = new FileOrchestrationStateStore(tempDir());
    await store.init();
    expect(await store.load('missing')).toBeUndefined();
    expect(await store.load('../../etc/passwd')).toBeUndefined();
  });

  it('remove deletes the run file', async () => {
    const store = new FileOrchestrationStateStore(tempDir());
    await store.init();
    await store.save(runState({ runId: 'gone' }));
    await store.remove('gone');
    expect(await store.load('gone')).toBeUndefined();
  });

  it('defaultOrchestrationsDir follows the sessions.ts convention', () => {
    expect(defaultOrchestrationsDir()).toBe(path.join(os.homedir(), '.sunday', 'orchestrations'));
  });
});

describe('reconcileOrchestrationRuns', () => {
  it("marks stale 'running' runs interrupted and cleans worktrees", async () => {
    const store = new FileOrchestrationStateStore(tempDir());
    await store.init();
    await store.save(runState({ runId: 'stale', status: 'running' }));
    await store.save(runState({ runId: 'finished', status: 'done' }));
    await store.save(runState({ runId: 'waiting', status: 'conflicted' }));

    const cleaned: string[] = [];
    await reconcileOrchestrationRuns(store, async (unit) => {
      cleaned.push(unit.id);
    });

    expect(await store.load('stale')).toMatchObject({ status: 'interrupted' });
    expect(cleaned).toEqual(['u1']); // only the unit with a worktreePath
    // Terminal and conflicted runs are untouched.
    expect(await store.load('finished')).toMatchObject({ status: 'done' });
    expect(await store.load('waiting')).toMatchObject({ status: 'conflicted' });
  });

  it('works without a cleanup callback', async () => {
    const store = new FileOrchestrationStateStore(tempDir());
    await store.init();
    await store.save(runState({ runId: 'stale2', status: 'running' }));
    await reconcileOrchestrationRuns(store);
    expect(await store.load('stale2')).toMatchObject({ status: 'interrupted' });
  });
});
