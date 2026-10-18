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
  pty: {
    spawn(id: string, cwd: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    kill(id: string): Promise<void>;
    onData(cb: (info: { id: string; data: string }) => void): () => void;
    onExit(cb: (info: { id: string; exitCode: number }) => void): () => void;
  };
  search: {
    text(query: string, dirPath: string): Promise<SearchResult[]>;
  };
  agent: {
    send(req: AgentRequest): Promise<AgentReply>;
    estimate(message: string): Promise<AgentEstimate>;
    usage(): Promise<AgentUsage>;
  };
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  text: string;
}

export type AgentMode = 'auto' | 'architect' | 'implementer' | 'reviewer';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentRequest {
  message: string;
  mode: AgentMode;
  model: string;
  history: AgentMessage[];
}

export interface AgentReply {
  content: string;
  /** When true, the hard budget was hit and the agent paused. */
  budgetPaused: boolean;
  /** Requests consumed by this turn (mock). */
  requestsUsed: number;
}

export interface AgentEstimate {
  min: number;
  max: number;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
}

export interface AgentUsage {
  used: number;
  limit: number;
  resetAt: string;
  taskSpend: number;
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
  pty: {
    spawn: (id, cwd, cols, rows) => ipcRenderer.invoke('sunday:pty:spawn', id, cwd, cols, rows),
    write: (id, data) => ipcRenderer.invoke('sunday:pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('sunday:pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('sunday:pty:kill', id),
    onData: (cb) => {
      const listener = (_e: unknown, info: { id: string; data: string }): void => cb(info);
      ipcRenderer.on('sunday:pty-data', listener);
      return () => ipcRenderer.removeListener('sunday:pty-data', listener);
    },
    onExit: (cb) => {
      const listener = (_e: unknown, info: { id: string; exitCode: number }): void => cb(info);
      ipcRenderer.on('sunday:pty-exit', listener);
      return () => ipcRenderer.removeListener('sunday:pty-exit', listener);
    },
  },
  search: {
    text: (query, dirPath) => ipcRenderer.invoke('sunday:search:text', query, dirPath),
  },
  agent: {
    send: (req) => ipcRenderer.invoke('sunday:agent:send', req),
    estimate: (message) => ipcRenderer.invoke('sunday:agent:estimate', message),
    usage: () => ipcRenderer.invoke('sunday:agent:usage'),
  },
};

contextBridge.exposeInMainWorld('sunday', api);
