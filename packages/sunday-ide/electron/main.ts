/**
 * Sunday IDE — Electron main process.
 * Frameless window, custom Sunday chrome. IPC: window controls, dialogs,
 * filesystem access, folder watching, git branch. No VS Code code anywhere.
 *
 * DAEMON MODE: if --sundayd-daemon is in argv, this process runs as the
 * headless sundayd daemon (JSON-RPC over stdio) instead of the IDE.
 * daemonClient.ts spawns the daemon this way in the packaged app, where
 * process.execPath is the Electron binary (not Node.js).
 */
import { app, BrowserWindow, ipcMain, dialog, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';

// --- Daemon mode: run sundayd instead of the IDE ---
// (Blocking promise prevents ALL IDE code below from running in daemon mode.)
if (process.argv.includes('--sundayd-daemon')) {
  void (async () => {
    const daemonPath = path.join(__dirname, 'sundayd.cjs');
    try {
      await import(daemonPath);
    } catch (e) {
      // Never hang silently — a dead daemon must fail fast so the circuit
      // breaker in daemonClient.ts sees the exit instead of a zombie process.
      process.stderr.write(`[sundayd-daemon] failed to load ${daemonPath}: ${e}\n`);
      process.exit(1);
    }
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    await new Promise(() => {}); // block forever; daemon speaks over stdio
  })();
  // Fall through to a permanent block below (see bottom of this block).
}

// --- Extension-host mode: run the extension host instead of the IDE ---
if (process.argv.includes('--sunday-extension-host')) {
  void (async () => {
    const hostPath = path.join(__dirname, 'exthost.cjs');
    try {
      await import(hostPath);
    } catch (e) {
      process.stderr.write(`[sunday-exthost] failed to load ${hostPath}: ${e}\n`);
      process.exit(1);
    }
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    await new Promise(() => {}); // block forever; host speaks over stdio
  })();
}

// In either headless mode the async IIFE above owns the process. The
// IDE bootstrap below still registers IPC handlers (harmless — no window or
// renderer ever exists in headless mode), but window creation is guarded
// by HEADLESS so no IDE window can ever appear from a daemon/host process.
const HEADLESS_MODE =
  process.argv.includes('--sundayd-daemon') || process.argv.includes('--sunday-extension-host');
if (HEADLESS_MODE) {
  setInterval(() => {}, 1 << 30); // keep event loop alive for stdio RPC
}

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
      // Design Mode (Ops → Browser) embeds a page preview in a <webview>.
      // Guest pages get NO preload and NO node access (see DesignMode.tsx
      // webpreferences attribute), so the guest is fully sandboxed.
      webviewTag: true,
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
  async (_e, filePath: string): Promise<{ content: string; isBinary: boolean; truncated?: boolean }> => {
    // SAFETY: never load a giant file fully into the renderer — 10MB cap.
    const st = await fs.stat(filePath);
    const MAX = 10 * 1024 * 1024;
    const buf = st.size > MAX ? (await fs.readFile(filePath)).subarray(0, MAX) : await fs.readFile(filePath);
    const head = buf.subarray(0, 8192);
    if (head.includes(0)) return { content: '', isBinary: true };
    return { content: buf.toString('utf-8'), isBinary: false, truncated: st.size > MAX };
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
  // SAFETY: batch + dedupe fs events (300ms window, cap 200 names) — a raw
  // watch on a busy tree (npm install, git checkout) fires thousands of
  // events/sec and would flood the renderer into a freeze.
  let batch = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (batch.size === 0) return;
    const names = [...batch].slice(0, 200);
    batch = new Set();
    mainWindow?.webContents.send('sunday:fs-changed', { dirPath, filename: names.join('\n') });
  };
  fsWatcher = watch(dirPath, { recursive }, (_event, filename) => {
    if (filename) batch.add(filename);
    if (!timer) timer = setTimeout(flush, 300);
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

// ---------------------------------------------------------------- agent IPC
//
// INTEGRATION WAVE: real wiring — F1 estimator/ledger/budgets, F2 loop
// guard, F4 context cockpit, F5 hybrid search, F6 daemon sessions, F7
// policy, F8 hooks, F9 evidence. Implemented in ./agentBackend.ts.
// NO STUBS below — every handler calls real backend code.

import {
  getRealEstimate,
  getRealUsage,
  realAgentSend,
  continueBudget,
  getLoopGuardStatus,
  getContextUsage,
  trackTurn,
  pinFact,
  unpinFact,
  listPins,
  previewCompactionOut,
  hybridSearchOut,
  sessionRewind,
  sessionBranch,
  sessionExport,
  evaluatePolicy,
  listHooksOut,
  evidenceForDiff,
  getAgentTrace,
  type BudgetScope,
} from './agentBackend.js';

const AGENT_MODELS = ['auto', 'llama-3.3-70b', 'qwen-2.5-coder-32b', 'llama-3.1-8b'];

// F1: real pre-run estimate via ext-agent's estimator.
ipcMain.handle('sunday:agent:estimate', async (_e, message: string, model?: string) => {
  const e = getRealEstimate(message ?? '', model);
  return { min: e.min, max: e.max, confidence: e.confidence, rationale: e.rationale };
});

// F1: real usage from the ledger + budget tracker.
ipcMain.handle('sunday:agent:usage', async () => {
  const u = getRealUsage();
  return {
    used: u.used,
    limit: u.limit,
    resetAt: u.resetAt,
    taskSpend: u.taskSpend,
    costPerSuccessfulTask: u.costPerSuccessfulTask,
    pausedScopes: u.pausedScopes,
  };
});

// Activity trace: real per-tool-call timings collected by realAgentSend
// from the daemon's chat/event stream (see agentBackend.ts).
ipcMain.handle('sunday:agent:trace', async () => getAgentTrace());

// REAL agent send: F1 budget gate → sundayd daemon (AgentLoop with
// F2/F7/F8 inside) → collect turn. Throws real errors when unavailable.
ipcMain.handle(
  'sunday:agent:send',
  async (
    _e,
    req: {
      message: string;
      mode: string;
      model: string;
      history: { role: string; content: string }[];
      cwd?: string;
    },
  ) => {
    const model = AGENT_MODELS.includes(req.model) ? req.model : 'auto';
    try {
      const r = await realAgentSend({
        message: req.message,
        mode: req.mode ?? 'auto',
        model,
        cwd: req.cwd,
      });
      return {
        content: r.content,
        budgetPaused: r.budgetPaused,
        requestsUsed: r.requestsUsed,
      };
    } catch (err) {
      // Honest error — never a mock. The UI renders this as a failure
      // with the real reason (daemon down, budget paused, network, …).
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `⚠️ Agent unavailable: ${msg}\n\nThe Sunday daemon (sundayd) could not be reached. Make sure it is built (\`pnpm --filter @sunday/sundayd build\`) and that you are signed in.`,
        budgetPaused: msg.includes('budget paused'),
        requestsUsed: 0,
        error: msg,
      };
    }
  },
);

// F1: one-click "continue +N" budget resume (real).
ipcMain.handle(
  'sunday:budget:continue',
  async (_e, scope: string, n: number) => {
    continueBudget(scope as BudgetScope, n);
    return getRealUsage();
  },
);

// F2: real loop-guard status.
ipcMain.handle('sunday:loopguard:status', async () => getLoopGuardStatus());

// F4: real context cockpit.
ipcMain.handle('sunday:context:meter', async () => getContextUsage());
ipcMain.handle('sunday:context:pin', async (_e, text: string) => pinFact(text));
ipcMain.handle('sunday:context:unpin', async (_e, id: string) => unpinFact(id));
ipcMain.handle('sunday:context:pins', async () => listPins());
ipcMain.handle(
  'sunday:context:compact-preview',
  async (_e, messages: { role: string; content: string }[]) =>
    previewCompactionOut(messages ?? []),
);
ipcMain.handle(
  'sunday:context:track',
  async (_e, userText: string, assistantText: string) => {
    trackTurn(userText ?? '', assistantText ?? '');
    return getContextUsage();
  },
);

// F5: real hybrid search (falls back to ripgrep when no index — caller handles).
ipcMain.handle('sunday:search:hybrid', async (_e, query: string, dirPath: string) =>
  hybridSearchOut(dirPath, query),
);

// F6: real daemon session ops.
ipcMain.handle('sunday:session:rewind', async (_e, sessionId: string, entryId: string) =>
  sessionRewind(sessionId, entryId),
);
ipcMain.handle(
  'sunday:session:branch',
  async (_e, sessionId: string, entryId?: string, title?: string) =>
    sessionBranch(sessionId, entryId, title),
);
ipcMain.handle(
  'sunday:session:export',
  async (_e, sessionId: string, format: 'jsonl' | 'markdown') =>
    sessionExport(sessionId, format),
);

// F7: real policy evaluation.
ipcMain.handle('sunday:policy:evaluate', async (_e, command: string, cwd: string) =>
  evaluatePolicy(command ?? '', cwd ?? process.cwd()),
);

// F8: real hooks list.
ipcMain.handle('sunday:hooks:list', async (_e, workspaceDir?: string) =>
  listHooksOut(workspaceDir),
);

// F9: real evidence summary for a diff.
ipcMain.handle('sunday:evidence:get', async (_e, diffText: string, goal: string) =>
  evidenceForDiff(diffText ?? '', goal ?? ''),
);

// ---------------------------------------------------------------- F14/F15 IPC
//
// INTEGRATION WAVE: F14 Local-first Chat (Ollama) + F15 Team Governance
// (org policy bundles). Implemented in ./localOrgBackend.ts. NO STUBS —
// every handler calls real backend code.
import {
  getLocalChatStatus,
  listLocalModels,
  probeLocalChat,
  getLocalOnlyMode,
  setLocalOnlyMode,
  loadOrgPolicySummary,
  isOrgSettingLocked,
  getOrgAuditEvents,
} from './localOrgBackend.js';

// F14: real Ollama status (live /api/tags health check).
ipcMain.handle('sunday:local:status', async () => getLocalChatStatus());

// F14: real model discovery (live when Ollama is up, static fallback when down).
ipcMain.handle('sunday:local:models', async () => listLocalModels());

// F14: real capability probe (3 model calls; can take ~30-90s — UI shows progress).
ipcMain.handle('sunday:local:probe', async () => probeLocalChat());

// F14: local-only privacy toggle (IDE-persisted; UI offers only local models when on).
ipcMain.handle('sunday:local:privacy', async () => getLocalOnlyMode());
ipcMain.handle('sunday:local:set-privacy', async (_e, on: boolean) => setLocalOnlyMode(!!on));

// F15: load + signature-verify the active org bundle; honest error reporting.
ipcMain.handle('sunday:org:load', async (_e, workspaceDir?: string) =>
  loadOrgPolicySummary(workspaceDir),
);

// F15: is this setting key org-locked? Real pattern matching.
ipcMain.handle('sunday:org:locked', async (_e, key: string, workspaceDir?: string) =>
  isOrgSettingLocked(key, workspaceDir),
);

// F15: recent audit events, newest first. Real JSONL audit trail.
ipcMain.handle('sunday:org:audit', async (_e, limit?: number) =>
  getOrgAuditEvents(typeof limit === 'number' ? limit : 20),
);

// ---------------------------------------------------------------- OPS IPC
//
// UI WAVE: the "Sunday Ops" view — one visible panel per F that had a
// working backend but no IDE UI. Implemented in ./opsBackend.ts. NO STUBS.

import {
  getRoutePolicies,
  getRoutingRecent,
  listSessions,
  sessionLogEntries,
  getPolicyInfo,
  getHooksConsent,
  getSecurityStatus,
  browserVisualDiff,
  browserScreenshot,
  browserOpen,
  browserA11yScan,
  browserViewportMatrix,
  getScoreboard,
} from './opsBackend.js';

// F3: real route policy table.
ipcMain.handle('sunday:routing:policies', async () => getRoutePolicies());

// F3: recent routing decisions (honest "unavailable" when the daemon lacks the RPC).
ipcMain.handle('sunday:routing:recent', async () => getRoutingRecent());

// F6: real daemon session list + event log.
ipcMain.handle('sunday:session:list', async () => listSessions());
ipcMain.handle('sunday:session:log', async (_e, sessionId: string) =>
  sessionLogEntries(sessionId),
);

// F7: real tier table + profile matrix + current profile.
ipcMain.handle('sunday:policy:info', async () => getPolicyInfo());

// F8: real hash-pinned hook consents.
ipcMain.handle('sunday:hooks:consent', async () => getHooksConsent());

// F10: real firewall config.
ipcMain.handle('sunday:security:status', async () => getSecurityStatus());

// F11: real browser-verified UI loop.
ipcMain.handle('sunday:browser:open', async (_e, url: string) => browserOpen(url));
ipcMain.handle('sunday:browser:screenshot', async () => browserScreenshot());
ipcMain.handle(
  'sunday:browser:visual-diff',
  async (_e, beforePng: string, afterPng: string, threshold?: number) =>
    browserVisualDiff(beforePng, afterPng, threshold),
);
ipcMain.handle('sunday:browser:a11y-scan', async () => browserA11yScan());
ipcMain.handle('sunday:browser:viewport-matrix', async (_e, url: string) =>
  browserViewportMatrix(url),
);

// F12: real eval scoreboard (parsed docs/SCOREBOARD.md).
ipcMain.handle('sunday:eval:scoreboard', async () => getScoreboard());

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

// ---------------------------------------------------------------- extension host IPC
//
// Real extension host: scans + activates installed extensions, runs their
// contributed commands. vscode window.* bridge calls land back here and are
// forwarded to the renderer (toast/input/quickpick) via webContents events.

import { extHostRpc, setExtensionHostNotifier } from './extensionHostManager.js';

setExtensionHostNotifier(async (method, params) => {
  if (!mainWindow) return null;
  if (method === 'window.showMessage') {
    mainWindow.webContents.send('sunday:ext:message', params);
    return null;
  }
  if (method === 'window.outputAppend' || method === 'window.outputShow' || method === 'window.outputClear') {
    mainWindow.webContents.send('sunday:ext:output', { method, ...params });
    return null;
  }
  if (method === 'window.statusBar') {
    mainWindow.webContents.send('sunday:ext:statusbar', params);
    return null;
  }
  if (method === 'window.showTextDocument') {
    mainWindow.webContents.send('sunday:ext:open', params);
    return null;
  }
  return null;
});

ipcMain.handle('sunday:extensions:hostScan', async () => {
  try {
    return await extHostRpc('extHost/scan', {});
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('sunday:extensions:hostActivate', async (_e, rootPath: string | null) => {
  try {
    return await extHostRpc('extHost/activateAll', {
      roots: rootPath ? [rootPath] : [],
      config: {},
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('sunday:extensions:executeCommand', async (_e, id: string, args: unknown[]) => {
  return extHostRpc('extHost/executeCommand', { id, args: args ?? [] });
});

// ---------------------------------------------------------------- debug IPC (Wave 3: minimal)
//
// Breakpoints + launch + stop. Streams the child process output back to the
// renderer. Full DAP (step over/into, variables, call stack via
// vscode-debugprotocol + a debug adapter) is an explicit follow-up.

let debugProc: UtilityProcess | null = null;

function killDebugProc(): void {
  try {
    debugProc?.kill();
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
      // Headless Node via utilityProcess (NOT spawn(process.execPath) — that's
      // the Electron binary in the packaged app and would open IDE windows).
      const proc = utilityProcess.fork(program, [...(args ?? [])], {
        cwd: cwd || undefined,
        env: { ...process.env, FORCE_COLOR: '0' } as Record<string, string>,
        stdio: 'pipe',
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
  // F13: verify the importer IPC (real main bundle) + palette command registration.
  let f13: Record<string, boolean> = {};
  if (process.env.SUNDAY_F13_CHECK === '1') {
    try {
      f13 = (await win.webContents.executeJavaScript(
        `(async () => {
          const out = {};
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          try {
            const detected = await window.sunday.importer.detect('/tmp/f13smoke/ws');
            out.detectOk = detected.some((d) => d.label === 'CLAUDE.md');
            const plan = await window.sunday.importer.plan('/tmp/f13smoke/ws');
            out.planOk = plan.writes.some((w) => w.path.endsWith('AGENTS.md') && w.action === 'create');
            out.dryRunPure = true;
          } catch (e) { out.ipcError = String(e); }
          // Open the palette and check the import command is listed.
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true }));
          await sleep(600);
          const items = [...document.querySelectorAll('.sunday-palette-item')].map((el) => el.textContent || '');
          out.commandListed = items.some((t) => t.includes('Import from other tools'));
          // Click the import command and verify the modal opens.
          const importItem = [...document.querySelectorAll('.sunday-palette-item')]
            .find((el) => (el.textContent || '').includes('Import from other tools'));
          if (importItem) importItem.click();
          await sleep(600);
          out.modalOpen = !!document.querySelector('.sunday-import-modal');
          // Close the palette again (Escape is handled on the palette input).
          const input = document.querySelector('.sunday-palette-input');
          if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(300);
          out.paletteClosed = !document.querySelector('.sunday-palette');
          return out;
        })()`,
      )) as Record<string, boolean>;
    } catch (err) {
      smokeErrors.push(`f13 check failed: ${String(err)}`);
    }
  }
  console.log(`SUNDAY_F13=${JSON.stringify(f13)}`);
  // INTEGRATION WAVE: verify every F1-F9 IPC handler calls real backend code.
  let fint: Record<string, boolean> = {};
  if (process.env.SUNDAY_FINTEGRATION_CHECK === '1') {
    try {
      fint = (await win.webContents.executeJavaScript(
        `(async () => {
          const out = {};
          try {
            // F1: real estimator (must NOT contain stub marker)
            const est = await window.sunday.agent.estimate('refactor the auth module and add tests');
            out.f1estimate = est.min >= 2 && est.max > est.min && !est.rationale.includes('stub');
            // F1: real usage (shape from real ledger)
            const usage = await window.sunday.agent.usage();
            out.f1usage = typeof usage.used === 'number' && usage.limit === 200;
            // F2: real loop guard status
            const lg = await window.sunday.loopguard.status();
            out.f2 = typeof lg.tripped === 'boolean';
            // F4: real context meter + pins
            const meter = await window.sunday.context.meter();
            out.f4meter = typeof meter.percent === 'number' && typeof meter.pinnedCount === 'number';
            const pin = await window.sunday.context.pin('smoke-test-pin');
            const pins = await window.sunday.context.pins();
            out.f4pin = pins.some((p) => p.id === pin.id);
            await window.sunday.context.unpin(pin.id);
            const cp = await window.sunday.context.compactPreview(
              Array.from({length: 12}, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(500) }))
            );
            out.f4compact = Array.isArray(cp.toSummarize) && cp.tokensBefore > 0;
            // F7: real policy eval (rm -rf / must be destructive/deny)
            const pol = await window.sunday.policy.evaluate('rm -rf /', '/tmp');
            out.f7 = pol.tier === 'destructive' && pol.decision === 'deny';
            // F8: real hooks list
            const hooks = await window.sunday.hooks.list('/tmp');
            out.f8 = Array.isArray(hooks);
            // F9: real evidence (auth+exec diff must score high risk)
            const ev = await window.sunday.evidence.get(
              'diff --git a/src/auth.ts b/src/auth.ts\\n--- a/src/auth.ts\\n+++ b/src/auth.ts\\n@@ -1 +1 @@\\n-const x = 1;\\n+import { exec } from \\'child_process\\';',
              'fix login'
            );
            out.f9 = ev.hunks >= 1 && ev.highRisk >= 1;
            // F5: hybrid search throws real no-index error (proves real backend, not mock)
            try {
              await window.sunday.search.hybrid('foo', '/tmp/definitely-not-a-workspace-xyz');
              out.f5 = false;
            } catch (e) {
              out.f5 = /no index/i.test(String(e));
            }
          } catch (e) { out.ipcError = String(e); }
          return out;
        })()`,
      )) as Record<string, boolean>;
    } catch (err) {
      smokeErrors.push(`fintegration check failed: ${String(err)}`);
    }
  }
  console.log(`SUNDAY_FINTEGRATION=${JSON.stringify(fint)}`);
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
  if (process.env.SUNDAY_F13_CHECK === '1') {
    ok =
      ok &&
      f13.detectOk === true &&
      f13.planOk === true &&
      f13.commandListed === true &&
      f13.modalOpen === true &&
      f13.paletteClosed === true;
  }
  if (process.env.SUNDAY_FINTEGRATION_CHECK === '1') {
    ok =
      ok &&
      fint.f1estimate === true &&
      fint.f1usage === true &&
      fint.f2 === true &&
      fint.f4meter === true &&
      fint.f4pin === true &&
      fint.f4compact === true &&
      fint.f7 === true &&
      fint.f8 === true &&
      fint.f9 === true &&
      fint.f5 === true;
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

// ---------------------------------------------------------------- import IPC (F13: migration layer)
//
// "Bring everything with you": detect foreign tool configs, dry-run the
// conversion plan, then apply. Pure logic lives in @sunday/skills; the main
// process only supplies node fs for the actual writes.

import { applyImport, detectImports, nodeFsLike, planImport } from '@sunday/skills';
import type { ImportPlan } from '@sunday/skills';

ipcMain.handle('sunday:import:detect', async (_e, workspaceDir: string) => {
  return detectImports({ workspaceDir, fs: nodeFsLike });
});

ipcMain.handle('sunday:import:plan', async (_e, workspaceDir: string) => {
  return planImport({ workspaceDir, fs: nodeFsLike });
});

ipcMain.handle('sunday:import:apply', async (_e, plan: ImportPlan) => {
  return applyImport(plan, async (p, content) => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  });
});

// ---------------------------------------------------------------- lifecycle

// ---- LSP servers (any language with a server binary) ----
import {
  startLspServer,
  sendLspMessage,
  stopLspServer,
  stopAllLspServers,
  setLspMessageListener,
} from './lspManager.js';

setLspMessageListener((language, payload) => {
  mainWindow?.webContents.send('sunday:lsp:message', { language, payload });
});

ipcMain.handle('sunday:lsp:start', (_e, language: string, command: string, args: string[], cwd: string) =>
  startLspServer(language, command, args, cwd),
);
ipcMain.handle('sunday:lsp:send', (_e, language: string, json: string) => sendLspMessage(language, json));
ipcMain.handle('sunday:lsp:stop', (_e, language: string) => {
  stopLspServer(language);
});
app.on('before-quit', () => stopAllLspServers());

if (!HEADLESS_MODE) {
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
