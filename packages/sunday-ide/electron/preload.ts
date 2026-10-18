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
    status(dirPath: string): Promise<GitStatusResult>;
    stage(dirPath: string, paths: string[]): Promise<{ ok: boolean; error?: string }>;
    unstage(dirPath: string, paths: string[]): Promise<{ ok: boolean; error?: string }>;
    commit(dirPath: string, message: string): Promise<{ ok: boolean; error?: string }>;
    diff(dirPath: string, filePath: string, staged: boolean): Promise<string>;
  };
  settings: {
    get(): Promise<SundaySettings>;
    set(patch: Partial<SundaySettings>): Promise<SundaySettings>;
  };
  extensions: {
    search(query: string): Promise<OpenVsxExtension[]>;
    list(): Promise<InstalledExtension[]>;
    install(ext: OpenVsxExtension): Promise<{ ok: boolean; error?: string }>;
    uninstall(id: string): Promise<{ ok: boolean; error?: string }>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
  };
  debug: {
    launch(cwd: string, program: string, args: string[]): Promise<{ ok: boolean; error?: string }>;
    stop(): Promise<void>;
    onOutput(cb: (info: { stream: 'stdout' | 'stderr'; text: string }) => void): () => void;
    onExit(cb: (info: { exitCode: number; error?: string }) => void): () => void;
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

export interface SundaySettings {
  theme: 'sunday-dark' | 'sunday-light';
  editorFontSize: number;
  editorFontFamily: string;
  editorTabSize: number;
  editorWordWrap: boolean;
  terminalFontSize: number;
}

export interface GitFileChange {
  path: string;
  /** Porcelain status letter: M, A, D, R, ?, U … */
  status: string;
  staged: boolean;
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  error?: string;
}

export interface OpenVsxExtension {
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  downloadUrl: string;
  iconUrl: string | null;
}

export interface InstalledExtension extends OpenVsxExtension {
  enabled: boolean;
  installedAt: string;
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
    status: (dirPath) => ipcRenderer.invoke('sunday:git:status', dirPath),
    stage: (dirPath, paths) => ipcRenderer.invoke('sunday:git:stage', dirPath, paths),
    unstage: (dirPath, paths) => ipcRenderer.invoke('sunday:git:unstage', dirPath, paths),
    commit: (dirPath, message) => ipcRenderer.invoke('sunday:git:commit', dirPath, message),
    diff: (dirPath, filePath, staged) => ipcRenderer.invoke('sunday:git:diff', dirPath, filePath, staged),
  },
  settings: {
    get: () => ipcRenderer.invoke('sunday:settings:get'),
    set: (patch) => ipcRenderer.invoke('sunday:settings:set', patch),
  },
  extensions: {
    search: (query) => ipcRenderer.invoke('sunday:extensions:search', query),
    list: () => ipcRenderer.invoke('sunday:extensions:list'),
    install: (ext) => ipcRenderer.invoke('sunday:extensions:install', ext),
    uninstall: (id) => ipcRenderer.invoke('sunday:extensions:uninstall', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('sunday:extensions:setEnabled', id, enabled),
  },
  debug: {
    launch: (cwd, program, args) => ipcRenderer.invoke('sunday:debug:launch', cwd, program, args),
    stop: () => ipcRenderer.invoke('sunday:debug:stop'),
    onOutput: (cb) => {
      const listener = (_e: unknown, info: { stream: 'stdout' | 'stderr'; text: string }): void => cb(info);
      ipcRenderer.on('sunday:debug-output', listener);
      return () => ipcRenderer.removeListener('sunday:debug-output', listener);
    },
    onExit: (cb) => {
      const listener = (_e: unknown, info: { exitCode: number; error?: string }): void => cb(info);
      ipcRenderer.on('sunday:debug-exit', listener);
      return () => ipcRenderer.removeListener('sunday:debug-exit', listener);
    },
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
