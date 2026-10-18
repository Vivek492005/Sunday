/**
 * Typed access to the Electron preload bridge (`window.sunday`).
 * Throws a clear error when the renderer is not running inside Sunday's
 * Electron shell (e.g. plain `vite dev` in a browser).
 */
import type { SundayAPI, FsEntry } from '../../electron/preload';

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

export const fileService = {
  openFolder(): Promise<string | null> {
    return bridge().dialog.openFolder();
  },
  readDir(dirPath: string): Promise<FsEntry[]> {
    return bridge().fs.readDir(dirPath);
  },
  readFile(filePath: string): Promise<{ content: string; isBinary: boolean }> {
    return bridge().fs.readFile(filePath);
  },
  writeFile(filePath: string, content: string): Promise<void> {
    return bridge().fs.writeFile(filePath, content);
  },
  createFile(filePath: string): Promise<void> {
    return bridge().fs.createFile(filePath);
  },
  createDir(dirPath: string): Promise<void> {
    return bridge().fs.createDir(dirPath);
  },
  deletePath(targetPath: string): Promise<void> {
    return bridge().fs.deletePath(targetPath);
  },
  renamePath(oldPath: string, newPath: string): Promise<void> {
    return bridge().fs.renamePath(oldPath, newPath);
  },
  watchStart(dirPath: string): Promise<void> {
    return bridge().watch.start(dirPath);
  },
  watchStop(): Promise<void> {
    return bridge().watch.stop();
  },
  onFsChanged(cb: (info: { dirPath: string; filename: string }) => void): () => void {
    return bridge().watch.onChanged(cb);
  },
  gitBranch(dirPath: string): Promise<string | null> {
    return bridge().git.branch(dirPath);
  },
};

export const windowControls = {
  minimize(): Promise<void> {
    return bridge().window.minimize();
  },
  maximize(): Promise<void> {
    return bridge().window.maximize();
  },
  close(): Promise<void> {
    return bridge().window.close();
  },
  isMaximized(): Promise<boolean> {
    return bridge().window.isMaximized();
  },
};

export type { FsEntry };
