/**
 * Minimal glob matcher for rule `globs` (and similar filters).
 *
 * Supported syntax:
 *   - `*`  — any run of characters except `/`
 *   - `**` — any run of characters, including `/` (also handles `/**/` and trailing `/**`)
 *   - `?`  — exactly one character except `/`
 *
 * Matching is against the workspace-relative path with `/` separators.
 * No new dependencies; intentionally tiny.
 */

/** Normalize a path for glob matching: backslashes → `/`, strip leading `./` and `/`. */
export function normalizeForGlob(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  while (out.startsWith('/')) out = out.slice(1);
  return out;
}

/** Compile a glob pattern to a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const src: string[] = ['^'];
  const p = normalizeForGlob(pattern);
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**`
        if (p[i + 2] === '/') {
          // `**/` — zero or more directories
          src.push('(?:.*/)?');
          i += 3;
        } else {
          src.push('.*');
          i += 2;
        }
      } else {
        src.push('[^/]*');
        i += 1;
      }
      continue;
    }
    if (c === '?') {
      src.push('[^/]');
      i += 1;
      continue;
    }
    if ('\\.+^${}()|[]'.includes(c)) src.push('\\' + c);
    else src.push(c);
    i += 1;
  }
  // Trailing `/**` also matches the bare directory itself: `docs/**` ~ `docs`.
  // (The trailing `/.*` is 3 chars; strip exactly those.)
  let re = src.join('');
  if (re.endsWith('/.*')) {
    re = re.slice(0, -3) + '(?:/.*)?';
  }
  return new RegExp(re + '$');
}

/**
 * Test whether `filePath` matches `pattern`.
 * `filePath` may be absolute or workspace-relative; when it is absolute and
 * `workspaceDir` is given, matching is done against the relative path.
 */
export function matchGlob(pattern: string, filePath: string, workspaceDir?: string): boolean {
  let rel = normalizeForGlob(filePath);
  if (workspaceDir) {
    const base = normalizeForGlob(workspaceDir);
    if (rel === base) rel = '';
    else if (rel.startsWith(base + '/')) rel = rel.slice(base.length + 1);
  }
  return globToRegExp(pattern).test(rel);
}

/** True when any of the patterns matches `filePath`. */
export function matchAnyGlob(patterns: string[], filePath: string, workspaceDir?: string): boolean {
  return patterns.some((p) => matchGlob(p, filePath, workspaceDir));
}
