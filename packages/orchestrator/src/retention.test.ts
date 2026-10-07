/**
 * P1-2/P1-3: orchestration retention sweep + file permissions.
 */
import { mkdtempSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utimesSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { FileOrchestrationStateStore } from './state.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRun(runId: string) {
  return { runId, status: 'done', units: [], createdAt: new Date().toISOString() };
}

describe('FileOrchestrationStateStore.sweepExpired', () => {
  it('purges runs older than retention window', async () => {
    vi.stubEnv('SUNDAY_RETENTION_DAYS', '30');
    const dir = mkdtempSync(join(tmpdir(), 'sunday-orch-'));
    const store = new FileOrchestrationStateStore(dir);
    await store.init();

    await store.save(makeRun('old-run') as any);
    const oldFile = join(dir, 'old-run.json');
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);
    await store.save(makeRun('new-run') as any);

    const purged = await store.sweepExpired();
    expect(purged).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(join(dir, 'new-run.json'))).toBe(true);
  });

  it('writes run files with 0600 permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sunday-orch-perm-'));
    const store = new FileOrchestrationStateStore(dir);
    await store.init();
    await store.save(makeRun('perm-run') as any);
    const st = statSync(join(dir, 'perm-run.json'));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('creates dir with 0700 permissions', async () => {
    const dir = join(tmpdir(), `sunday-orch-dir-${Date.now()}`);
    const store = new FileOrchestrationStateStore(dir);
    await store.init();
    const st = statSync(dir);
    expect(st.mode & 0o777).toBe(0o700);
  });
});
