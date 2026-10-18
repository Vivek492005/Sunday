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
    void loadDevWithRetry(mainWindow, 60);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (process.env.SUNDAY_SMOKE === '1') void runSmokeCheck(mainWindow);
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
  console.log(`SUNDAY_SMOKE_ERRORS=${JSON.stringify(smokeErrors)}`);
  const ok =
    dom.shell === true &&
    dom.titlebar === true &&
    dom.rail === true &&
    dom.welcome === true &&
    ipc.readDirOk === true &&
    ipc.roundTripOk === true &&
    smokeErrors.length === 0;
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
