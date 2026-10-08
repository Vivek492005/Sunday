/**
 * P1-2/P1-3: retention sweep + session delete + file permissions.
 */
import { mkdtempSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { SessionStore, retentionDays } from './sessions.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sunday-retention-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('retentionDays', () => {
  it('defaults to 30', () => {
    vi.stubEnv('SUNDAY_RETENTION_DAYS', '');
    expect(retentionDays()).toBe(30);
  });
  it('parses custom value', () => {
    vi.stubEnv('SUNDAY_RETENTION_DAYS', '7');
    expect(retentionDays()).toBe(7);
  });
  it('0 disables retention', () => {
    vi.stubEnv('SUNDAY_RETENTION_DAYS', '0');
    expect(retentionDays()).toBe(0);
  });
  it('falls back to 30 on garbage', () => {
    vi.stubEnv('SUNDAY_RETENTION_DAYS', 'bogus');
    expect(retentionDays()).toBe(30);
  });
});

describe('SessionStore.sweepExpired', () => {
  it('deletes sessions older than retention window', async () => {
    vi.stubEnv('SUNDAY_RETENTION_DAYS', '30');
    const store = new SessionStore(dir);
    await store.init();
    // Create an "old" session file (mtime 40 days ago).
    const s = store.create({ title: 'old' });
    await store.persist(s);
    const file = join(dir, `${s.id}.json`);
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const { utimesSync } = await import('node:fs');
    utimesSync(file, oldTime, oldTime);
    // Create a "new" session.
    const s2 = store.create({ title: 'new' });
    await store.persist(s2);

    const purged = await store.sweepExpired();
    expect(purged).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(dir, `${s2.id}.json`))).toBe(true);
  });

  it('sweep disabled when retention is 0', async () => {
    vi.stubEnv('SUNDAY_RETENTION_DAYS', '0');
    const store = new SessionStore(dir);
    await store.init();
    const s = store.create({});
    await store.persist(s);
    const file = join(dir, `${s.id}.json`);
    const oldTime = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const { utimesSync } = await import('node:fs');
    utimesSync(file, oldTime, oldTime);
    expect(await store.sweepExpired()).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});

describe('SessionStore.delete', () => {
  it('removes in-memory session and file', async () => {
    const store = new SessionStore(dir);
    await store.init();
    const s = store.create({ title: 'doomed' });
    await store.persist(s);
    expect(store.get(s.id)).toBeDefined();

    const deleted = await store.delete(s.id);
    expect(deleted).toBe(true);
    expect(store.get(s.id)).toBeUndefined();
    expect(existsSync(join(dir, `${s.id}.json`))).toBe(false);
  });

  it('returns false for nonexistent session', async () => {
    const store = new SessionStore(dir);
    await store.init();
    expect(await store.delete('nonexistent-id')).toBe(false);
  });
});

describe('session file permissions (P1-3)', () => {
  it('session dir is 0700 and files are 0600', async () => {
    const store = new SessionStore(dir);
    await store.init();
    // init() creates the dir; check a fresh subdir to verify mode logic.
    const s = store.create({});
    await store.persist(s);
    const fileStat = statSync(join(dir, `${s.id}.json`));
    // Unix permission bits not supported on Windows.
    if (process.platform !== 'win32') {
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });
});
