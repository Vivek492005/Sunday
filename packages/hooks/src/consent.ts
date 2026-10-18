/**
 * @sunday/hooks — hash-pinned first-run consent for repo-level hooks.
 *
 * Repo hooks are arbitrary code. They NEVER run without:
 *   1. workspace trust (checked by the caller, sundayd), AND
 *   2. explicit user consent for the exact file hash.
 *
 * Consent is stored at `~/.sunday/hooks-consent.json`:
 *   { "<sha256>": { consentedAt: <epoch ms>, workspaceRoot: "<root>" } }
 * Any byte change to `.sunday/hooks.json` → new hash → re-consent required.
 * Fail closed: unreadable/corrupt consent store = no consent.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const CONSENT_FILE_NAME = 'hooks-consent.json';

interface ConsentEntry {
  consentedAt: number;
  workspaceRoot: string;
}

type ConsentStore = Record<string, ConsentEntry>;

function consentPath(homeDir: string): string {
  return join(homeDir, '.sunday', CONSENT_FILE_NAME);
}

function readStore(homeDir: string): ConsentStore {
  try {
    const raw = readFileSync(consentPath(homeDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: ConsentStore = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof v === 'object' &&
        v !== null &&
        typeof (v as ConsentEntry).consentedAt === 'number' &&
        typeof (v as ConsentEntry).workspaceRoot === 'string'
      ) {
        out[k] = v as ConsentEntry;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(homeDir: string, store: ConsentStore): void {
  const p = consentPath(homeDir);
  mkdirSync(dirname(p), { recursive: true });
  // Best-effort: a failed write just means consent won't persist.
  try {
    writeFileSync(p, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    /* fail closed — caller treats missing consent as not consented */
  }
}

/** Has the user consented to this exact repo-hooks hash? */
export function hasConsented(repoHash: string, homeDir: string = homedir()): boolean {
  return readStore(homeDir)[repoHash] !== undefined;
}

/** Record consent for a repo-hooks hash. */
export function recordConsent(
  repoHash: string,
  workspaceRoot: string,
  homeDir: string = homedir(),
): void {
  const store = readStore(homeDir);
  store[repoHash] = { consentedAt: Date.now(), workspaceRoot };
  writeStore(homeDir, store);
}

/** Revoke consent (e.g. "don't trust these hooks anymore"). */
export function revokeConsent(repoHash: string, homeDir: string = homedir()): void {
  const store = readStore(homeDir);
  delete store[repoHash];
  writeStore(homeDir, store);
}

/** When consent was recorded, for UI display. Undefined = never. */
export function consentInfo(
  repoHash: string,
  homeDir: string = homedir(),
): ConsentEntry | undefined {
  return readStore(homeDir)[repoHash];
}
