/**
 * @sunday/hooks — glob matching for hook matchers (tool names + paths).
 *
 * Pure, dependency-free. Supports `*` (within a segment), `**` (across
 * segments), `?` (single char). Paths are normalized to `/` separators
 * before matching so Windows paths work too.
 */

import type { HookMatcher } from './schema.js';

/** Convert a glob pattern to a RegExp. */
export function globToRegExp(glob: string): RegExp {
  // Trailing `/**` also matches the bare directory itself
  // (e.g. `src/**` matches `src` as well as `src/a/b`).
  let pattern = glob;
  let trailingDir = false;
  if (pattern.endsWith('/**')) {
    pattern = pattern.slice(0, -3);
    trailingDir = true;
  }

  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` — zero or more whole path segments.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += escapeRegExpChar(c);
      i += 1;
    }
  }
  if (trailingDir) re += '(?:/.*)?';
  return new RegExp(`^${re}$`);
}

function escapeRegExpChar(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/** Normalize a path for matching: backslashes → slashes. */
export function normalizePathForMatch(p: string): string {
  return p.replace(/\\/g, '/');
}

/** True when `value` matches at least one glob in `patterns`. Empty list = match-all. */
export function matchesAny(value: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((g) => globToRegExp(g).test(value));
}

/** Extract the "primary path" from tool arguments (path/file/filePath). */
export function primaryPathFromArgs(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const o = args as Record<string, unknown>;
  for (const key of ['path', 'file', 'filePath', 'target']) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Does a hook matcher apply to this tool call?
 * - tools: glob list matched against the tool name (empty = all tools)
 * - paths: glob list matched against the call's primary path arg
 *   (a hook with path matchers but no extractable path does NOT match —
 *   fail closed so path-scoped blocks can't be bypassed by arg renaming)
 */
export function hookMatches(matcher: HookMatcher, toolName: string, args: unknown): boolean {
  if (!matchesAny(toolName, matcher.tools)) return false;
  if (matcher.paths.length === 0) return true;
  const p = primaryPathFromArgs(args);
  if (p === undefined) return false;
  return matchesAny(normalizePathForMatch(p), matcher.paths);
}
