// sundayd — browser walkthrough artifact media helpers (Browser Agent UI phase).
//
// Walkthrough artifacts live under <workspaceDir>/.sunday/artifacts/<sessionId>/
// with PNG screenshots in the media/ subdir and walkthrough.md next to it.
// Names are deduped with -2, -3… suffixes so concurrent or repeated runs
// never clobber an earlier artifact.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Default session id: browser-<yyyymmdd>-<hhmmss> (local time). */
export function defaultSessionId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `browser-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * Keep the session id a single safe path segment (strip traversal attempts;
 * fall back to the default id when it ends up empty).
 */
export function sanitizeSessionId(sessionId: string | undefined): string {
  const clean = (sessionId ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean.length > 0 ? clean : defaultSessionId();
}

/**
 * Resolve (and create) <workspaceDir>/.sunday/artifacts/<sessionId>/media.
 * sessionId defaults to browser-<yyyymmdd>-<hhmmss>. Returns the absolute
 * media dir path.
 */
export function resolveSessionMediaDir(workspaceDir: string, sessionId?: string): string {
  const id = sanitizeSessionId(sessionId);
  const dir = resolve(workspaceDir, '.sunday', 'artifacts', id, 'media');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** First free path for baseName + ext in dir: name.ext, name-2.ext, name-3.ext… */
function uniquePath(dir: string, baseName: string, ext: string): string {
  let candidate = join(dir, `${baseName}${ext}`);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${baseName}-${n}${ext}`);
    n++;
  }
  return candidate;
}

/** Write PNG bytes as <baseName>.png (deduping with -2, -3…), return abs path. */
export function savePng(png: Buffer, dir: string, baseName: string): string {
  mkdirSync(dir, { recursive: true });
  const path = uniquePath(dir, baseName, '.png');
  writeFileSync(path, png);
  return path;
}

/**
 * Write text as <name> (deduping with -2, -3… before the extension, e.g.
 * walkthrough.md → walkthrough-2.md), return the absolute path.
 */
export function writeTextFile(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const path = uniquePath(dir, base, ext);
  writeFileSync(path, content, 'utf8');
  return path;
}
