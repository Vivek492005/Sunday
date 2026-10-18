/**
 * @sunday/hooks — loading + merging hooks.json files.
 *
 * Sources (in increasing precedence for *disabling*, both run otherwise):
 *   1. `<workspaceRoot>/.sunday/hooks.json` — repo-level (untrusted code:
 *      needs workspace trust + hash-pinned first-run consent)
 *   2. `~/.sunday/hooks.json` — user-level (the user's own machine)
 *
 * Both files' enabled hooks run. A user-level hook named
 * `disable:<repo-hook-name>` disables the repo hook of that name —
 * the user's own policy always wins.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tryParseHooksFile, type HookDef, type HooksFile } from './schema.js';

export const HOOKS_FILE_NAME = 'hooks.json';
export const SUNDAY_DIR_NAME = '.sunday';

/** Where a hook definition came from. */
export type HookSource = 'repo' | 'user';

export interface LoadedHook extends HookDef {
  source: HookSource;
}

/** SHA-256 hex of the raw file bytes (for hash-pinned consent). */
export function hashHooksBytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface LoadResult {
  /** All enabled hooks to run (repo + user, user disables applied). */
  hooks: LoadedHook[];
  /** Raw bytes of the repo file (for consent hashing) — undefined if absent. */
  repoBytes: Buffer | undefined;
  /** SHA-256 of repoBytes — undefined if no repo file. */
  repoHash: string | undefined;
  /** Non-fatal load/parse problems (a bad file never kills the agent). */
  errors: string[];
}

function readJsonFile(path: string): { raw: Buffer; parsed: HooksFile } | { error: string } {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return { error: `not found: ${path}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return { error: `invalid JSON in ${path}: ${(e as Error).message}` };
  }
  const parsed = tryParseHooksFile(json);
  if (!parsed) return { error: `schema validation failed in ${path}` };
  return { raw, parsed };
}

/**
 * Load hooks for a workspace. Never throws — returns errors instead.
 * `homeDir` is injectable for tests.
 */
export function loadHooks(workspaceRoot: string, homeDir: string = homedir()): LoadResult {
  const errors: string[] = [];
  const repoPath = join(workspaceRoot, SUNDAY_DIR_NAME, HOOKS_FILE_NAME);
  const userPath = join(homeDir, SUNDAY_DIR_NAME, HOOKS_FILE_NAME);

  const repo = readJsonFile(repoPath);
  const user = readJsonFile(userPath);

  let repoBytes: Buffer | undefined;
  let repoHash: string | undefined;
  const repoHooks: LoadedHook[] = [];
  if ('parsed' in repo) {
    repoBytes = repo.raw;
    repoHash = hashHooksBytes(repo.raw);
    for (const h of repo.parsed.hooks) {
      if (h.enabled) repoHooks.push({ ...h, source: 'repo' });
    }
  } else if (!repo.error.startsWith('not found')) {
    errors.push(repo.error);
  }

  const userHooks: LoadedHook[] = [];
  if ('parsed' in user) {
    for (const h of user.parsed.hooks) {
      if (h.enabled) userHooks.push({ ...h, source: 'user' });
    }
  } else if (!user.error.startsWith('not found')) {
    errors.push(user.error);
  }

  // User-level `disable:<name>` hooks turn off the repo hook of that name.
  const disabled = new Set<string>();
  for (const h of userHooks) {
    if (h.name.startsWith('disable:')) disabled.add(h.name.slice('disable:'.length));
  }
  const liveRepo = repoHooks.filter((h) => !disabled.has(h.name));
  const liveUser = userHooks.filter((h) => !h.name.startsWith('disable:'));

  // Repo hooks run first (they're the project's policy), then the user's.
  return { hooks: [...liveRepo, ...liveUser], repoBytes, repoHash, errors };
}
