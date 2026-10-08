// Unit tests for the SyncStore (D3): verbatim storage, 0600 files,
// user-id sanitization (no path traversal), missing-user behavior.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SYNC_BLOB_BYTES, SyncStore, syncFileName } from './sync.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sunday-sync-test-'));
  const store = new SyncStore(dir);
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  return { store, dir, cleanup };
}

describe('syncFileName', () => {
  it('uses plain ids as-is', () => {
    expect(syncFileName('user123')).toBe('user123.json');
    expect(syncFileName('a-b_c')).toBe('a-b_c.json');
  });

  it('hashes hostile ids (path traversal impossible)', () => {
    for (const bad of ['../evil', '../../x', 'a/b', 'a\\b', '', 'x'.repeat(65), '.hidden']) {
      const name = syncFileName(bad);
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toContain('..');
      expect(name.endsWith('.json')).toBe(true);
    }
    // deterministic + distinct
    expect(syncFileName('../evil')).toBe(syncFileName('../evil'));
    expect(syncFileName('../evil')).not.toBe(syncFileName('../other'));
  });
});

describe('SyncStore', () => {
  it('round-trips the blob verbatim (server never transforms it)', () => {
    const { store, cleanup } = tmpStore();
    try {
      const blob = '{"v":1,"data":"opaque+ciphertext=="}';
      store.save('u1', blob, '2026-10-08T00:00:00.000Z');
      const rec = store.load('u1');
      expect(rec?.blob).toBe(blob);
      // The file on disk contains the blob byte-for-byte: nothing was
      // parsed, re-serialized, or (critically) decrypted.
      const raw = readFileSync(store.pathFor('u1'), 'utf8');
      expect(JSON.parse(raw).blob).toBe(blob);
      // The envelope only wraps the blob (JSON-escaped); it never alters it.
      expect(raw).toContain(JSON.stringify(blob).slice(1, -1));
    } finally {
      cleanup();
    }
  });

  it('stores files with mode 0600', () => {
    const { store, cleanup } = tmpStore();
    try {
      store.save('u1', 'blob', 't');
      // Unix permission bits not supported on Windows.
      if (process.platform !== 'win32') {
        expect(store.modeFor('u1')).toBe(0o600);
      }
    } finally {
      cleanup();
    }
  });

  it('returns undefined for users who never synced', () => {
    const { store, cleanup } = tmpStore();
    try {
      expect(store.load('nobody')).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('last write wins on updated_at', () => {
    const { store, cleanup } = tmpStore();
    try {
      store.save('u1', 'first', 't1');
      store.save('u1', 'second', 't2');
      const rec = store.load('u1');
      expect(rec?.blob).toBe('second');
      expect(rec?.updated_at).toBe('t2');
    } finally {
      cleanup();
    }
  });

  it('isolates users', () => {
    const { store, cleanup } = tmpStore();
    try {
      store.save('alice', 'a-blob', 't');
      expect(store.load('bob')).toBeUndefined();
      expect(store.load('alice')?.blob).toBe('a-blob');
    } finally {
      cleanup();
    }
  });

  it('hostile user ids stay inside the sync dir', () => {
    const { store, dir, cleanup } = tmpStore();
    try {
      store.save('../../evil', 'x', 't');
      expect(store.pathFor('../../evil').startsWith(dir)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('exposes the 5 MiB cap constant', () => {
    expect(MAX_SYNC_BLOB_BYTES).toBe(5 * 1024 * 1024);
  });
});
