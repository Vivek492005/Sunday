/**
 * Sunday IDE — Electron main process.
 * Frameless window, custom Sunday chrome. IPC: window controls, dialogs,
 * filesystem access, folder watching, git branch. No VS Code code anywhere.
 */
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';

const isDev = process.env.SUNDAY_DEV === '1';

let mainWindow: BrowserWindow | null = null;
let fsWatcher: { close(): void } | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1a1611',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    const win = mainWindow;
    if (win) void loadDevWithRetry(win, 60);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    const win = mainWindow;
    win?.show();
    if (process.env.SUNDAY_SMOKE === '1' && win) void runSmokeCheck(win);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    stopWatcher();
  });
}

async function loadDevWithRetry(win: BrowserWindow, attempts: number): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await win.loadURL('http://localhost:5173');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.error('Sunday IDE: dev server not reachable on :5173');
}

// ---------------------------------------------------------------- window IPC

ipcMain.handle('sunday:window:minimize', () => mainWindow?.minimize());
ipcMain.handle('sunday:window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('sunday:window:close', () => mainWindow?.close());
ipcMain.handle('sunday:window:isMaximized', () => mainWindow?.isMaximized() ?? false);

// ---------------------------------------------------------------- dialog IPC

ipcMain.handle('sunday:dialog:openFolder', async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Open Folder in Sunday',
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// ---------------------------------------------------------------- fs IPC

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('sunday:fs:readDir', async (_e, dirPath: string): Promise<FsEntry[]> => {
  const names = await fs.readdir(dirPath);
  const entries: FsEntry[] = [];
  for (const name of names) {
    const full = path.join(dirPath, name);
    try {
      const st = await fs.stat(full);
      entries.push({ name, path: full, isDirectory: st.isDirectory() });
    } catch {
      // unreadable entry — skip
    }
  }
  entries.sort((a, b) =>
    a.isDirectory !== b.isDirectory
      ? a.isDirectory
        ? -1
        : 1
      : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  return entries;
});

ipcMain.handle(
  'sunday:fs:readFile',
  async (_e, filePath: string): Promise<{ content: string; isBinary: boolean }> => {
    const buf = await fs.readFile(filePath);
    const head = buf.subarray(0, 8192);
    if (head.includes(0)) return { content: '', isBinary: true };
    return { content: buf.toString('utf-8'), isBinary: false };
  },
);

ipcMain.handle('sunday:fs:writeFile', async (_e, filePath: string, content: string) => {
  await fs.writeFile(filePath, content, 'utf-8');
});

ipcMain.handle('sunday:fs:createFile', async (_e, filePath: string) => {
  if (await pathExists(filePath)) throw new Error('File already exists');
  await fs.writeFile(filePath, '', 'utf-8');
});

ipcMain.handle('sunday:fs:createDir', async (_e, dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true });
});

ipcMain.handle('sunday:fs:deletePath', async (_e, targetPath: string) => {
  const st = await fs.stat(targetPath);
  if (st.isDirectory()) await fs.rm(targetPath, { recursive: true, force: true });
  else await fs.unlink(targetPath);
});

ipcMain.handle('sunday:fs:renamePath', async (_e, oldPath: string, newPath: string) => {
  if (await pathExists(newPath)) throw new Error('A file with that name already exists');
  await fs.rename(oldPath, newPath);
});

// ---------------------------------------------------------------- watch IPC

ipcMain.handle('sunday:watch:start', async (_e, dirPath: string) => {
  stopWatcher();
  const { watch } = await import('node:fs');
  const recursive = process.platform === 'darwin' || process.platform === 'win32';
  fsWatcher = watch(dirPath, { recursive }, (_event, filename) => {
    mainWindow?.webContents.send('sunday:fs-changed', { dirPath, filename: filename ?? '' });
  });
});

ipcMain.handle('sunday:watch:stop', () => stopWatcher());

function stopWatcher(): void {
  try {
    fsWatcher?.close();
  } catch {
    // already closed
  }
  fsWatcher = null;
}

// ---------------------------------------------------------------- git IPC

ipcMain.handle('sunday:git:branch', async (_e, dirPath: string): Promise<string | null> => {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dirPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout.trim() || null);
      },
    );
  });
});

// ---------------------------------------------------------------- pty IPC

import type { IPty } from '@lydell/node-pty';

interface PtyEntry {
  proc: IPty;
}

const ptySessions = new Map<string, PtyEntry>();

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/bash';
}

ipcMain.handle(
  'sunday:pty:spawn',
  async (_e, id: string, cwd: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> => {
    try {
      if (ptySessions.has(id)) {
        try { ptySessions.get(id)?.proc.kill(); } catch { /* already dead */ }
        ptySessions.delete(id);
      }
      // Lazy require so a missing native module never breaks startup.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pty = require('@lydell/node-pty') as typeof import('@lydell/node-pty');
      const shell = defaultShell();
      // Fall back to the user's home dir when no folder is open.
      let spawnCwd = cwd;
      if (!spawnCwd) {
        try {
          spawnCwd = (await import('node:os')).homedir();
        } catch {
          spawnCwd = process.cwd();
        }
      }
      const proc: IPty = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: Math.max(20, cols || 80),
        rows: Math.max(10, rows || 24),
        cwd: spawnCwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
      });
      ptySessions.set(id, { proc });
      proc.onData((data: string) => {
        mainWindow?.webContents.send('sunday:pty-data', { id, data });
      });
      proc.onExit(({ exitCode }: { exitCode: number }) => {
        ptySessions.delete(id);
        mainWindow?.webContents.send('sunday:pty-exit', { id, exitCode });
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
);

ipcMain.handle('sunday:pty:write', async (_e, id: string, data: string) => {
  ptySessions.get(id)?.proc.write(data);
});

ipcMain.handle('sunday:pty:resize', async (_e, id: string, cols: number, rows: number) => {
  try {
    ptySessions.get(id)?.proc.resize(Math.max(20, cols), Math.max(10, rows));
  } catch {
    // resize on a dead pty — ignore
  }
});

ipcMain.handle('sunday:pty:kill', async (_e, id: string) => {
  try {
    ptySessions.get(id)?.proc.kill();
  } catch {
    // already dead
  }
  ptySessions.delete(id);
});

// ---------------------------------------------------------------- search IPC

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  text: string;
}

const SEARCH_MAX_RESULTS = 200;

function nodeSearchFallback(query: string, dirPath: string): Promise<SearchResult[]> {
  // Pure-Node recursive search used when ripgrep is unavailable.
  // Skips binary files, node_modules, .git, and dist folders.
  return (async () => {
    const results: SearchResult[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'dist-electron', '.hg', '__pycache__']);
    const q = query.toLowerCase();
    async function walk(dir: string): Promise<void> {
      if (results.length >= SEARCH_MAX_RESULTS) return;
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (results.length >= SEARCH_MAX_RESULTS) return;
        if (skip.has(name)) continue;
        const full = path.join(dir, name);
        let st;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          await walk(full);
        } else if (st.isFile() && st.size < 1024 * 1024) {
          let buf;
          try {
            buf = await fs.readFile(full);
          } catch {
            continue;
          }
          if (buf.subarray(0, 8192).includes(0)) continue; // binary
          const text = buf.toString('utf-8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const idx = lines[i].toLowerCase().indexOf(q);
            if (idx >= 0) {
              results.push({ path: full, line: i + 1, column: idx + 1, text: lines[i].trim().slice(0, 200) });
              if (results.length >= SEARCH_MAX_RESULTS) return;
            }
          }
        }
      }
    }
    await walk(dirPath);
    return results;
  })();
}

ipcMain.handle(
  'sunday:search:text',
  async (_e, query: string, dirPath: string): Promise<SearchResult[]> => {
    const q = (query ?? '').trim();
    if (!q || !dirPath) return [];
    // Prefer ripgrep when available — fast and respects .gitignore.
    return new Promise((resolve) => {
      execFile(
        'rg',
        [
          '--json', '--no-heading', '--column', '--max-count', '20',
          '-g', '!node_modules', '-g', '!.git', '-g', '!dist', '-g', '!dist-electron',
          q, dirPath,
        ],
        { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (!err) {
            try {
              const results: SearchResult[] = [];
              for (const line of stdout.split('\n')) {
                if (!line.trim()) continue;
                const obj = JSON.parse(line) as {
                  type: string;
                  data?: { path?: { text?: string }; line_number?: number; submatches?: { start: number; match: { text: string } }[]; lines?: { text?: string } };
                };
                if (obj.type === 'match' && obj.data?.path?.text && results.length < SEARCH_MAX_RESULTS) {
                  const sm = obj.data.submatches?.[0];
                  results.push({
                    path: obj.data.path.text,
                    line: obj.data.line_number ?? 1,
                    column: (sm?.start ?? 0) + 1,
                    text: (obj.data.lines?.text ?? '').trim().slice(0, 200),
                  });
                }
              }
              resolve(results);
              return;
            } catch {
              // fall through to Node fallback
            }
          }
          // rg missing or failed — pure-Node fallback
          void nodeSearchFallback(q, dirPath).then(resolve);
        },
      );
    });
  },
);

// ---------------------------------------------------------------- agent IPC (STUB)
//
// TODO(Wave 3): wire these to the real Sunday agent loop in
// `packages/ext-agent` (gateway chat, F1 estimator, usage ledger, budgets).
// The renderer + preload contracts are final; only this main-process
// implementation needs swapping. Mock responses below keep the Agent panel
// fully demoable until then.

const AGENT_MODELS = ['auto', 'llama-3.3-70b', 'qwen-2.5-coder-32b', 'llama-3.1-8b'];

const MOCK_REPLIES: Record<string, string> = {
  auto: `Here's what I'd do — this is a **mock reply** from the Sunday IDE agent stub.

\`\`\`ts
// Wave 3 will connect this panel to the real ext-agent loop.
export async function chat(message: string) {
  return gateway.chat({ message, mode: 'auto' });
}
\`\`\`

Ask me to **explain code**, **write a function**, or **debug an error** — the real agent lands in Wave 3.`,
  architect: `## Plan (mock)\n\n1. **Survey** the codebase structure first\n2. **Design** the module boundaries\n3. **Propose** 2–3 approaches with trade-offs\n\n> Wave 3 connects this to the real Architect mode.`,
  implementer: `On it — here's a starter implementation (mock):\n\n\`\`\`python\ndef sunday_hello(name: str) -> str:\n    return f"Hello, {name} — from Sunday IDE!"\n\`\`\`\n\nWave 3 wires this to the real Implementer mode with file edits.`,
  reviewer: `## Review (mock)\n\n- ✅ Clear naming\n- ⚠️ Missing error handling on the happy path\n- 💡 Consider extracting the retry logic\n\nWave 3 connects this to the real Reviewer mode.`,
};

ipcMain.handle('sunday:agent:estimate', async (_e, message: string) => {
  // Mirrors packages/ext-agent F1 estimator heuristic (client-side copy for the stub).
  const text = message ?? '';
  let point = 4 + Math.floor(text.length / 400) * 1.5;
  const codeBlocks = Math.floor((text.match(/```/g) ?? []).length / 2);
  point += codeBlocks * 3;
  if (/\b(test|run|build|fix|debug|execute)\b/i.test(text)) point += 3;
  if (/\b(refactor|migrate|implement|rewrite|scaffold|feature)\b/i.test(text)) point += 4.5;
  point = Math.max(2, Math.round(point));
  return {
    min: Math.max(2, Math.round(point * 0.6)),
    max: Math.round(point * 1.6),
    confidence: text.length > 200 ? 'medium' : 'low',
    rationale: 'stub heuristic — real F1 estimator lands with ext-agent wiring',
  };
});

ipcMain.handle('sunday:agent:usage', async () => {
  // Stub usage — real ledger comes with ext-agent wiring (Wave 3).
  return { used: 37, limit: 200, resetAt: '00:00 UTC', taskSpend: 4 };
});

ipcMain.handle(
  'sunday:agent:send',
  async (_e, req: { message: string; mode: string; model: string; history: { role: string; content: string }[] }) => {
    const mode = (req.mode ?? 'auto') as keyof typeof MOCK_REPLIES;
    const model = AGENT_MODELS.includes(req.model) ? req.model : 'auto';
    // Simulate latency so the UI streaming/loading states are exercised.
    await new Promise((r) => setTimeout(r, 900));
    const content = `${MOCK_REPLIES[mode] ?? MOCK_REPLIES.auto}\n\n_Mode: ${mode} · Model: ${model}_`;
    return { content, budgetPaused: false, requestsUsed: 3 };
  },
);

// ---------------------------------------------------------------- settings IPC
//
// Persisted at ~/.sunday-ide/settings.json. Wave 3: Editor, Terminal,
// Agent, Appearance groups.

import os from 'node:os';

export interface SundaySettings {
  theme: 'sunday-dark' | 'sunday-light';
  editorFontSize: number;
  editorFontFamily: string;
  editorTabSize: number;
  editorWordWrap: boolean;
  terminalFontSize: number;
}

export const DEFAULT_SETTINGS: SundaySettings = {
  theme: 'sunday-dark',
  editorFontSize: 13.5,
  editorFontFamily: "'JetBrains Mono', 'Cascadia Code', ui-monospace, Menlo, Consolas, monospace",
  editorTabSize: 2,
  editorWordWrap: false,
  terminalFontSize: 13,
};

const SUNDAY_HOME = path.join(os.homedir(), '.sunday-ide');
const SETTINGS_FILE = path.join(SUNDAY_HOME, 'settings.json');

async function readSettings(): Promise<SundaySettings> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SundaySettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

ipcMain.handle('sunday:settings:get', async (): Promise<SundaySettings> => {
  return readSettings();
});

ipcMain.handle(
  'sunday:settings:set',
  async (_e, patch: Partial<SundaySettings>): Promise<SundaySettings> => {
    const current = await readSettings();
    const next: SundaySettings = { ...current, ...patch };
    await fs.mkdir(SUNDAY_HOME, { recursive: true });
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf-8');
    return next;
  },
);

// ---------------------------------------------------------------- git IPC (Wave 3: source control)
//
// Raw git CLI — no new dependencies. Porcelain parsing lives in
// src/services/gitParse.ts so it stays unit-testable.

import { parseGitPorcelain, type GitFileChange } from '../src/services/gitParse.js';

function gitRun(
  dirPath: string,
  args: string[],
  timeoutMs = 30000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dirPath, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout ?? '', stderr: (stderr ?? '').trim() });
    });
  });
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  error?: string;
}

ipcMain.handle('sunday:git:status', async (_e, dirPath: string): Promise<GitStatusResult> => {
  if (!dirPath) return { isRepo: false, branch: null, staged: [], unstaged: [] };
  const inside = await gitRun(dirPath, ['rev-parse', '--is-inside-work-tree'], 5000);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { isRepo: false, branch: null, staged: [], unstaged: [] };
  }
  const [branchRes, statusRes] = await Promise.all([
    gitRun(dirPath, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000),
    gitRun(dirPath, ['status', '--porcelain=v1', '-uall']),
  ]);
  const { staged, unstaged } = parseGitPorcelain(statusRes.stdout);
  return {
    isRepo: true,
    branch: branchRes.ok ? branchRes.stdout.trim() || null : null,
    staged,
    unstaged,
    error: statusRes.ok ? undefined : statusRes.stderr,
  };
});

ipcMain.handle(
  'sunday:git:stage',
  async (_e, dirPath: string, paths: string[]): Promise<{ ok: boolean; error?: string }> => {
    if (!dirPath || paths.length === 0) return { ok: true };
    const r = await gitRun(dirPath, ['add', '--', ...paths]);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr || 'git add failed' };
  },
);

ipcMain.handle(
  'sunday:git:unstage',
  async (_e, dirPath: string, paths: string[]): Promise<{ ok: boolean; error?: string }> => {
    if (!dirPath || paths.length === 0) return { ok: true };
    const r = await gitRun(dirPath, ['restore', '--staged', '--', ...paths]);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr || 'git restore failed' };
  },
);

ipcMain.handle(
  'sunday:git:commit',
  async (_e, dirPath: string, message: string): Promise<{ ok: boolean; error?: string }> => {
    const msg = (message ?? '').trim();
    if (!dirPath || !msg) return { ok: false, error: 'Commit message is empty' };
    const r = await gitRun(dirPath, ['commit', '-m', msg]);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr || 'git commit failed' };
  },
);

ipcMain.handle(
  'sunday:git:diff',
  async (_e, dirPath: string, filePath: string, staged: boolean): Promise<string> => {
    if (!dirPath || !filePath) return '';
    const args = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath];
    const r = await gitRun(dirPath, args);
    if (r.ok && r.stdout.trim()) return r.stdout;
    // Untracked file: diff against /dev/null so new files show their content.
    if (!staged) {
      const r2 = await gitRun(dirPath, ['diff', '--no-index', '--', '/dev/null', filePath]);
      return r2.stdout || '';
    }
    return '';
  },
);

// ---------------------------------------------------------------- extensions IPC (Wave 3)
//
// Open VSX registry browsing + VSIX install into ~/.sunday-ide/extensions.
// NOTE: there is no extension host yet — installed extensions are inert
// until the host lands (follow-up). This wave ships the full UI +
// install/uninstall mechanics.

export interface OpenVsxExtension {
  id: string; // namespace.name
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

const EXTENSIONS_DIR = path.join(SUNDAY_HOME, 'extensions');
const EXT_MANIFEST = 'sunday-ext.json';

interface RawOpenVsxHit {
  namespace?: string;
  name?: string;
  displayName?: string;
  description?: string;
  version?: string;
  files?: { download?: string };
  iconUrl?: string;
}

export function parseOpenVsxSearch(json: unknown): OpenVsxExtension[] {
  const root = (json ?? {}) as { extensions?: RawOpenVsxHit[] };
  const hits = Array.isArray(root.extensions) ? root.extensions : [];
  return hits
    .filter((h) => h && typeof h.namespace === 'string' && typeof h.name === 'string')
    .map((h) => {
      const namespace = h.namespace as string;
      const name = h.name as string;
      const version = typeof h.version === 'string' && h.version ? h.version : 'latest';
      return {
        id: `${namespace}.${name}`,
        namespace,
        name,
        displayName: typeof h.displayName === 'string' && h.displayName ? h.displayName : name,
        description: typeof h.description === 'string' ? h.description : '',
        version,
        downloadUrl:
          (h.files && typeof h.files.download === 'string' && h.files.download) ||
          `https://open-vsx.org/api/${namespace}/${name}/${version}/file/${namespace}.${name}-${version}.vsix`,
        iconUrl: typeof h.iconUrl === 'string' ? h.iconUrl : null,
      };
    });
}

ipcMain.handle('sunday:extensions:search', async (_e, query: string): Promise<OpenVsxExtension[]> => {
  const q = (query ?? '').trim() || '*';
  const url = `https://open-vsx.org/api/-/search?query=${encodeURIComponent(q)}&size=24&includeAllVersions=false`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'SundayIDE/1.0' } });
    if (!res.ok) return [];
    const json: unknown = await res.json();
    return parseOpenVsxSearch(json);
  } catch {
    return [];
  }
});

ipcMain.handle('sunday:extensions:list', async (): Promise<InstalledExtension[]> => {
  try {
    const names = await fs.readdir(EXTENSIONS_DIR);
    const out: InstalledExtension[] = [];
    for (const name of names) {
      try {
        const raw = await fs.readFile(path.join(EXTENSIONS_DIR, name, EXT_MANIFEST), 'utf-8');
        out.push(JSON.parse(raw) as InstalledExtension);
      } catch {
        // not a Sunday-managed extension dir — skip
      }
    }
    out.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
    return out;
  } catch {
    return [];
  }
});

ipcMain.handle(
  'sunday:extensions:install',
  async (_e, ext: OpenVsxExtension): Promise<{ ok: boolean; error?: string }> => {
    if (!ext || !ext.id || !ext.downloadUrl) return { ok: false, error: 'Invalid extension' };
    const targetDir = path.join(EXTENSIONS_DIR, ext.id);
    const tmpFile = path.join(os.tmpdir(), `sunday-ext-${Date.now()}.vsix`);
    try {
      const res = await fetch(ext.downloadUrl, { headers: { 'User-Agent': 'SundayIDE/1.0' } });
      if (!res.ok) return { ok: false, error: `Download failed (${res.status})` };
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(tmpFile, buf);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AdmZip = require('adm-zip') as new (p: string) => { extractAllTo(d: string, o: boolean): void };
      const zip = new AdmZip(tmpFile);
      await fs.mkdir(targetDir, { recursive: true });
      zip.extractAllTo(targetDir, true);
      const manifest: InstalledExtension = {
        ...ext,
        enabled: true,
        installedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(targetDir, EXT_MANIFEST), JSON.stringify(manifest, null, 2), 'utf-8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      try {
        await fs.unlink(tmpFile);
      } catch {
        // best effort
      }
    }
  },
);

ipcMain.handle(
  'sunday:extensions:uninstall',
  async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
    if (!id) return { ok: false, error: 'Invalid extension id' };
    try {
      await fs.rm(path.join(EXTENSIONS_DIR, id), { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

ipcMain.handle('sunday:extensions:setEnabled', async (_e, id: string, enabled: boolean) => {
  if (!id) return;
  const manifestPath = path.join(EXTENSIONS_DIR, id, EXT_MANIFEST);
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as InstalledExtension;
    manifest.enabled = enabled;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  } catch {
    // missing manifest — ignore
  }
});

// ---------------------------------------------------------------- debug IPC (Wave 3: minimal)
//
// Breakpoints + launch + stop. Streams the child process output back to the
// renderer. Full DAP (step over/into, variables, call stack via
// vscode-debugprotocol + a debug adapter) is an explicit follow-up.

import { spawn, type ChildProcess } from 'node:child_process';

let debugProc: ChildProcess | null = null;

function killDebugProc(): void {
  try {
    debugProc?.kill('SIGKILL');
  } catch {
    // already dead
  }
  debugProc = null;
}

ipcMain.handle(
  'sunday:debug:launch',
  async (_e, cwd: string, program: string, args: string[]): Promise<{ ok: boolean; error?: string }> => {
    if (!program) return { ok: false, error: 'No program to launch' };
    killDebugProc();
    try {
      const proc = spawn(process.execPath, [program, ...(args ?? [])], {
        cwd: cwd || undefined,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      debugProc = proc;
      proc.stdout?.on('data', (d: Buffer) => {
        mainWindow?.webContents.send('sunday:debug-output', { stream: 'stdout', text: d.toString('utf-8') });
      });
      proc.stderr?.on('data', (d: Buffer) => {
        mainWindow?.webContents.send('sunday:debug-output', { stream: 'stderr', text: d.toString('utf-8') });
      });
      proc.on('exit', (code) => {
        if (debugProc === proc) debugProc = null;
        mainWindow?.webContents.send('sunday:debug-exit', { exitCode: code ?? -1 });
      });
      proc.on('error', (err) => {
        if (debugProc === proc) debugProc = null;
        mainWindow?.webContents.send('sunday:debug-exit', { exitCode: -1, error: String(err) });
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

ipcMain.handle('sunday:debug:stop', async () => {
  killDebugProc();
});

app.on('before-quit', () => killDebugProc());

// ---------------------------------------------------------------- smoke test

const smokeErrors: string[] = [];

/**
 * SUNDAY_SMOKE=1: after the window shows, inspect the rendered DOM for the
 * Sunday shell, print renderer console errors, and exit. Used by CI/VM
 * verification where no human can look at the screen.
 */
async function runSmokeCheck(win: BrowserWindow): Promise<void> {
  win.webContents.on('console-message', (_e, _level, message) => {
    if (/error/i.test(message)) smokeErrors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    smokeErrors.push(`render-process-gone: ${details.reason}`);
  });
  await new Promise((r) => setTimeout(r, 7000));
  let dom: Record<string, unknown> = {};
  let ipc: Record<string, unknown> = {};
  try {
    dom = (await win.webContents.executeJavaScript(
      `({
        title: document.title,
        shell: !!document.querySelector('.sunday-app'),
        titlebar: !!document.querySelector('.sunday-titlebar'),
        rail: !!document.querySelector('.sunday-rail'),
        sidebar: !!document.querySelector('.sunday-sidebar'),
        editorArea: !!document.querySelector('.sunday-editor-area'),
        statusbar: !!document.querySelector('.sunday-statusbar'),
        welcome: !!document.querySelector('.sunday-welcome'),
      })`,
    )) as Record<string, unknown>;
    ipc = (await win.webContents.executeJavaScript(
      `(async () => {
        const dir = await window.sunday.fs.readDir('/tmp');
        await window.sunday.fs.writeFile('/tmp/__sunday_smoke__.txt', 'smoke-ok');
        const back = await window.sunday.fs.readFile('/tmp/__sunday_smoke__.txt');
        await window.sunday.fs.deletePath('/tmp/__sunday_smoke__.txt');
        return {
          readDirOk: Array.isArray(dir),
          roundTripOk: back.content === 'smoke-ok' && back.isBinary === false,
        };
      })()`,
    )) as Record<string, unknown>;
  } catch (err) {
    smokeErrors.push(`executeJavaScript failed: ${String(err)}`);
  }
  console.log(`SUNDAY_SMOKE_DOM=${JSON.stringify(dom)}`);
  console.log(`SUNDAY_SMOKE_IPC=${JSON.stringify(ipc)}`);
  // Wave 3: optional deeper check — click through the new rail views.
  let wave3: Record<string, boolean> = {};
  if (process.env.SUNDAY_WAVE3_CHECK === '1') {
    try {
      wave3 = (await win.webContents.executeJavaScript(
        `(async () => {
          const out = {};
          const click = (title) => {
            const btn = [...document.querySelectorAll('.sunday-rail-btn')]
              .find((b) => b.getAttribute('title') === title);
            if (btn) { btn.click(); return true; }
            return false;
          };
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          click('Source Control'); await sleep(500);
          out.source = !!document.querySelector('.sunday-sc-root');
          click('Extensions'); await sleep(500);
          out.extensions = !!document.querySelector('.sunday-ext-root');
          click('Run & Debug'); await sleep(500);
          out.debug = !!document.querySelector('.sunday-debug-root');
          click('Settings (Ctrl+,)'); await sleep(500);
          out.settings = !!document.querySelector('.sunday-settings');
          // close settings with Escape
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          await sleep(300);
          out.settingsClosed = !document.querySelector('.sunday-settings');
          return out;
        })()`,
      )) as Record<string, boolean>;
    } catch (err) {
      smokeErrors.push(`wave3 check failed: ${String(err)}`);
    }
  }
  console.log(`SUNDAY_WAVE3=${JSON.stringify(wave3)}`);
  console.log(`SUNDAY_SMOKE_ERRORS=${JSON.stringify(smokeErrors)}`);
  let ok =
    dom.shell === true &&
    dom.titlebar === true &&
    dom.rail === true &&
    dom.welcome === true &&
    ipc.readDirOk === true &&
    ipc.roundTripOk === true &&
    smokeErrors.length === 0;
  if (process.env.SUNDAY_WAVE3_CHECK === '1') {
    ok =
      ok &&
      wave3.source === true &&
      wave3.extensions === true &&
      wave3.debug === true &&
      wave3.settings === true &&
      wave3.settingsClosed === true;
  }
  try {
    const shot = await win.webContents.capturePage();
    const out = process.env.SUNDAY_SMOKE_SHOT ?? '/tmp/sunday-ide-smoke.png';
    await fs.writeFile(out, shot.toPNG());
    console.log(`SUNDAY_SMOKE_SHOT=${out}`);
  } catch (err) {
    console.log(`SUNDAY_SMOKE_SHOT_FAILED=${String(err)}`);
  }
  console.log(`SUNDAY_SMOKE_RESULT=${ok ? 'PASS' : 'FAIL'}`);
  app.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
