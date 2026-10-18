/**
 * Bundles the Electron main process + preload with esbuild.
 * Keeps renderer (vite) and main (node) builds independent.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');

await build({
  entryPoints: [path.join(root, 'electron', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: path.join(root, 'dist-electron', 'main.cjs'),
  external: ['electron'],
  logLevel: 'info',
});

await build({
  entryPoints: [path.join(root, 'electron', 'preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: path.join(root, 'dist-electron', 'preload.cjs'),
  external: ['electron'],
  logLevel: 'info',
});

console.log('electron build ok');
