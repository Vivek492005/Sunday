/**
 * Dev helper: builds the electron side once, then launches `electron .`
 * with SUNDAY_DEV=1 so the frameless window loads the Vite dev server.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');

const build = spawn(process.execPath, [path.join(dir, 'build-electron.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
build.on('exit', (code) => {
  if (code !== 0) {
    console.error('electron build failed');
    process.exit(code ?? 1);
  }
  const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const child = spawn(electronBin, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SUNDAY_DEV: '1' },
  });
  child.on('exit', (c) => process.exit(c ?? 0));
});
