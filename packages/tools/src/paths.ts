import path from 'node:path';

export class PathEscapeError extends Error {
  constructor(p: string) {
    super(`path escapes workspace root: ${p}`);
    this.name = 'PathEscapeError';
  }
}

/** Resolve p against root; throw PathEscapeError if it escapes root.
 *  All file tools go through this — the model can never reach outside the
 *  workspace, even with `..` or absolute paths. */
export function resolveWithinRoot(root: string, p: string): string {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, p);
  if (abs === absRoot) return absRoot;
  const rel = path.relative(absRoot, abs);
  // On Windows, cross-drive relatives come back absolute.
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
    throw new PathEscapeError(p);
  }
  return abs;
}
