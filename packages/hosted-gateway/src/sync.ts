/**
 * @sunday/hosted-gateway — per-user encrypted session-sync blob store (D3).
 *
 * ============================================================================
 * SECURITY CONTRACT — READ BEFORE TOUCHING THIS FILE
 * ============================================================================
 * The server stores ONLY opaque blobs. It NEVER decrypts:
 *   - No key material, passphrases, or KDF parameters are ever accepted as
 *     anything but opaque bytes inside the blob envelope.
 *   - There is no AES / PBKDF2 / WebCrypto code anywhere in this package.
 *   - Encryption and decryption happen EXCLUSIVELY in the IDE extension
 *     (packages/ext-agent/src/sync.ts), with a key derived from the user's
 *     own passphrase via PBKDF2-SHA256 (100,000 iterations). The passphrase
 *     never leaves the user's machine.
 * A compromise of this server (or its backups) yields ciphertext only.
 * ============================================================================
 *
 * Storage: one JSON file per user under <dataDir>/sync/<safeUserId>.json,
 * mode 0600 (same posture as AccountsService's sessions.json). Only the
 * latest blob is kept — conflict resolution is last-writer-wins on
 * `updated_at` (the client confirms before overwriting on download).
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { defaultDataDir } from './accounts.js';

/** Maximum encrypted blob accepted by POST /sync/sessions (5 MiB). */
export const MAX_SYNC_BLOB_BYTES = 5 * 1024 * 1024;

export interface SyncRecord {
  blob: string;
  updated_at: string;
}

/**
 * Map a user id to a safe file name. Plain ids (alphanumerics, dash,
 * underscore, <=64 chars) are used as-is for debuggability; anything else
 * becomes a SHA-256 digest so hostile ids can never escape the sync dir.
 */
export function syncFileName(userId: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return `${userId}.json`;
  return `u_${createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 32)}.json`;
}

export class SyncStore {
  private readonly dir: string;

  constructor(dataDir?: string) {
    this.dir = join(dataDir ?? defaultDataDir(), 'sync');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Absolute path of a user's blob file; always inside the sync dir. */
  pathFor(userId: string): string {
    const p = resolve(this.dir, syncFileName(userId));
    if (!p.startsWith(this.dir + sep)) {
      // Defense in depth — syncFileName already sanitizes.
      throw new Error('unsafe user id');
    }
    return p;
  }

  /** Store the blob verbatim (no parsing, no transformation, no decrypt). */
  save(userId: string, blob: string, updatedAt: string): void {
    const record = JSON.stringify({
      blob,
      updated_at: updatedAt,
      saved_at: new Date().toISOString(),
    });
    writeFileSync(this.pathFor(userId), record, { encoding: 'utf8', mode: 0o600 });
  }

  /** Load the stored blob, or undefined when the user never synced. */
  load(userId: string): SyncRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(userId), 'utf8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const { blob, updated_at } = parsed as { blob?: unknown; updated_at?: unknown };
    if (typeof blob !== 'string' || typeof updated_at !== 'string') return undefined;
    return { blob, updated_at };
  }

  /** File mode of a stored blob (tests assert 0600). */
  modeFor(userId: string): number | undefined {
    try {
      return statSync(this.pathFor(userId)).mode & 0o777;
    } catch {
      return undefined;
    }
  }
}
