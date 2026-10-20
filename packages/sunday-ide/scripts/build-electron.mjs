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
  external: ['electron', '@lydell/node-pty', '@lydell/node-pty-*'],
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

// Bundle the sundayd daemon into a single file so the packaged app
// ships it (the installer only includes dist/ + dist-electron/).
// daemonClient.ts resolves this bundled copy first, then the dev path.
await build({
  entryPoints: [path.join(root, '..', 'sundayd', 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: path.join(root, 'dist-electron', 'sundayd.cjs'),
  // Native / external modules the daemon shells out to or loads dynamically.
  external: ['electron', '@lydell/node-pty', '@lydell/node-pty-*'],
  // CJS has no import.meta.url — shim it so createRequire(import.meta.url) works.
  banner: {
    js: `var __sundayPtfu = require('node:url').pathToFileURL;\nvar __sundayImportMetaUrl = __sundayPtfu(__filename).href;`,
  },
  define: {
    'import.meta.url': '__sundayImportMetaUrl',
  },
  logLevel: 'info',
});

console.log('sundayd bundle ok');

// Bundle the extension host — loaded by main.ts in --sunday-extension-host mode.
await build({
  entryPoints: [path.join(root, 'electron', 'extHost', 'host.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: path.join(root, 'dist-electron', 'exthost.cjs'),
  external: ['electron'],
  banner: {
    js: `var __sundayPtfu = require('node:url').pathToFileURL;\nvar __sundayImportMetaUrl = __sundayPtfu(__filename).href;`,
  },
  define: {
    'import.meta.url': '__sundayImportMetaUrl',
  },
  logLevel: 'info',
});

console.log('extension host bundle ok');
