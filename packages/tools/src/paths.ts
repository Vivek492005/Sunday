import path from 'node:path';
import { realpathSync } from 'node:fs';

export class PathEscapeError extends Error {
  constructor(p: string) {
    super(`path escapes workspace root: ${p}`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolve p against root; throw PathEscapeError if it escapes root.
 * All file tools go through this — the model can never reach outside the
 * workspace, even with `..` or absolute paths.
 *
 * Symlinks are canonicalised with `realpath` (per §15.2 "Path rules"): a
 * symlink *inside* the workspace that points *outside* it (e.g. a malicious
 * repo shipping `link -> /etc`) is treated as an escape. Paths that do not
 * exist yet (new files) resolve against their nearest existing ancestor so
 * `write_file` keeps working.
 */
export function resolveWithinRoot(root: string, p: string): string {
  const absRoot = realpathSync(root);
  const abs = path.resolve(absRoot, p);
  const canonical = canonicalizeNearest(abs);
  if (canonical === absRoot) return canonical;
  const rel = path.relative(absRoot, canonical);
  // On Windows, cross-drive relatives come back absolute.
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
    throw new PathEscapeError(p);
  }
  return canonical;
}

/**
 * Canonicalise `abs`, resolving symlinks. When `abs` (or an ancestor) does
 * not exist yet, resolve the nearest existing ancestor and re-append the
 * remaining segments lexically. Throws the fs error when nothing exists.
 */
function canonicalizeNearest(abs: string): string {
  let cur = abs;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e; // filesystem root itself missing — rethrow
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}
