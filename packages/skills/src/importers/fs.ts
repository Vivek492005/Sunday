/**
 * Minimal fs abstraction so the detector/converters stay pure and testable.
 * Production code passes the node-backed implementation; tests pass an
 * in-memory one.
 */
import { promises as nodeFs } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';

export interface FsLike {
  readFile(path: string): Promise<string | null>;
  /** Names (not full paths) inside a directory, or null when unreadable. */
  readdir(path: string): Promise<string[] | null>;
  homedir(): string;
  platform(): NodeJS.Platform;
}

export const nodeFsLike: FsLike = {
  async readFile(path: string): Promise<string | null> {
    try {
      return await nodeFs.readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  async readdir(path: string): Promise<string[] | null> {
    try {
      return await nodeFs.readdir(path);
    } catch {
      return null;
    }
  },
  homedir(): string {
    return nodeHomedir();
  },
  platform(): NodeJS.Platform {
    return process.platform;
  },
};

/** In-memory FsLike for tests. Keys are absolute paths. */
export function memoryFsLike(
  files: Record<string, string>,
  opts?: { home?: string; platform?: NodeJS.Platform },
): FsLike {
  const home = opts?.home ?? '/home/test';
  const platform = opts?.platform ?? 'linux';
  return {
    async readFile(path: string): Promise<string | null> {
      return path in files ? files[path] : null;
    },
    async readdir(path: string): Promise<string[] | null> {
      const prefix = path.endsWith('/') ? path : path + '/';
      const names = new Set<string>();
      let found = false;
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) {
          found = true;
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf('/');
          names.add(slash === -1 ? rest : rest.slice(0, slash));
        }
      }
      // Also treat explicitly registered dirs (trailing-slash keys) as existing.
      if (`${path}/` in files) found = true;
      return found ? [...names] : null;
    },
    homedir(): string {
      return home;
    },
    platform(): NodeJS.Platform {
      return platform;
    },
  };
}
