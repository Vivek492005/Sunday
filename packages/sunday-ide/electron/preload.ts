/**
 * Sunday IDE — preload bridge. Exposes a minimal, typed `window.sunday` API
 * over context isolation. No Node access leaks into the renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface SundayAPI {
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
  dialog: {
    openFolder(): Promise<string | null>;
  };
  fs: {
    readDir(dirPath: string): Promise<FsEntry[]>;
    readFile(filePath: string): Promise<{ content: string; isBinary: boolean }>;
    writeFile(filePath: string, content: string): Promise<void>;
    createFile(filePath: string): Promise<void>;
    createDir(dirPath: string): Promise<void>;
    deletePath(targetPath: string): Promise<void>;
    renamePath(oldPath: string, newPath: string): Promise<void>;
  };
  watch: {
    start(dirPath: string): Promise<void>;
    stop(): Promise<void>;
    onChanged(cb: (info: { dirPath: string; filename: string }) => void): () => void;
  };
  git: {
    branch(dirPath: string): Promise<string | null>;
  };
}

const api: SundayAPI = {
  window: {
    minimize: () => ipcRenderer.invoke('sunday:window:minimize'),
    maximize: () => ipcRenderer.invoke('sunday:window:maximize'),
    close: () => ipcRenderer.invoke('sunday:window:close'),
    isMaximized: () => ipcRenderer.invoke('sunday:window:isMaximized'),
  },
  dialog: {
    openFolder: () => ipcRenderer.invoke('sunday:dialog:openFolder'),
  },
  fs: {
    readDir: (dirPath) => ipcRenderer.invoke('sunday:fs:readDir', dirPath),
    readFile: (filePath) => ipcRenderer.invoke('sunday:fs:readFile', filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke('sunday:fs:writeFile', filePath, content),
    createFile: (filePath) => ipcRenderer.invoke('sunday:fs:createFile', filePath),
    createDir: (dirPath) => ipcRenderer.invoke('sunday:fs:createDir', dirPath),
    deletePath: (targetPath) => ipcRenderer.invoke('sunday:fs:deletePath', targetPath),
    renamePath: (oldPath, newPath) => ipcRenderer.invoke('sunday:fs:renamePath', oldPath, newPath),
  },
  watch: {
    start: (dirPath) => ipcRenderer.invoke('sunday:watch:start', dirPath),
    stop: () => ipcRenderer.invoke('sunday:watch:stop'),
    onChanged: (cb) => {
      const listener = (
        _e: unknown,
        info: { dirPath: string; filename: string },
      ): void => cb(info);
      ipcRenderer.on('sunday:fs-changed', listener);
      return () => ipcRenderer.removeListener('sunday:fs-changed', listener);
    },
  },
  git: {
    branch: (dirPath) => ipcRenderer.invoke('sunday:git:branch', dirPath),
  },
};

contextBridge.exposeInMainWorld('sunday', api);
