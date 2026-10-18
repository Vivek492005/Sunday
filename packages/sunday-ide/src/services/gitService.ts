/**
 * Typed access to the Sunday git bridge (`window.sunday.git`).
 * Raw git CLI in the main process — no new dependencies.
 */
import type {
  SundayAPI,
  GitFileChange,
  GitStatusResult,
} from '../../electron/preload';

declare global {
  interface Window {
    sunday?: SundayAPI;
  }
}

function bridge(): SundayAPI {
  const api = window.sunday;
  if (!api) {
    throw new Error(
      'Sunday bridge unavailable — the Sunday IDE renderer must run inside the Electron shell (`pnpm dev`).',
    );
  }
  return api;
}

export const gitService = {
  branch(dirPath: string): Promise<string | null> {
    return bridge().git.branch(dirPath);
  },
  status(dirPath: string): Promise<GitStatusResult> {
    return bridge().git.status(dirPath);
  },
  stage(dirPath: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
    return bridge().git.stage(dirPath, paths);
  },
  unstage(dirPath: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
    return bridge().git.unstage(dirPath, paths);
  },
  commit(dirPath: string, message: string): Promise<{ ok: boolean; error?: string }> {
    return bridge().git.commit(dirPath, message);
  },
  diff(dirPath: string, filePath: string, staged: boolean): Promise<string> {
    return bridge().git.diff(dirPath, filePath, staged);
  },
};

export type { GitFileChange, GitStatusResult };
