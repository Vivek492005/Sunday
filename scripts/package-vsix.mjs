#!/usr/bin/env node
// Package the Sunday VS Code extension as a .vsix (Phase 7).
//
//   node scripts/package-vsix.mjs [--out <dir>]
//
// Prerequisites: `pnpm install` and `pnpm -r build` have run (tsc + vite +
// esbuild outputs exist). vsce must be on PATH (`npm i -g @vscode/vsce`).
//
// Layout inside the vsix (matches the sidecar/webview discovery):
//   package.json            extension manifest
//   dist/extension.cjs      extension host bundle
//   ui-chat/dist/           chat webview
//   ui-manager/dist/        manager webview
//   sundayd/sundayd.mjs      sidecar (esbuild ESM bundle, run with VS Code's node)
//   sundayd/browserd.mjs     browser child (esbuild ESM bundle, spawned by sundayd)

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const OUT = outFlag === -1 ? join(ROOT, 'dist-package') : resolve(args[outFlag + 1]);
const STAGE = join(OUT, 'stage');

const version = JSON.parse(readFileSync(join(ROOT, 'packages/ext-agent/package.json'), 'utf8')).version;

function sh(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(' ')}`);
  // On Windows, .cmd shims (vsce) only resolve via PATHEXT under a shell.
  execFileSync(cmd, argv, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...opts });
}

function need(path, what) {
  if (!existsSync(path)) {
    console.error(`missing ${what}: ${path}\nrun \`pnpm -r build\` first.`);
    process.exit(1);
  }
}

// 0. inputs exist
need(join(ROOT, 'packages/ext-agent/dist/extension.cjs'), 'extension bundle');
need(join(ROOT, 'packages/ui-chat/dist/index.html'), 'ui-chat build');
need(join(ROOT, 'packages/ui-manager/dist/index.html'), 'ui-manager build');

// 1. bundle the sidecars (via esbuild's JS API — cross-platform, no .bin
//    shell-script resolution issues on Windows)
const { buildSync } = await import(
  pathToFileURL(join(ROOT, 'packages/ext-agent/node_modules/esbuild/lib/main.js')).href
);
function bundle(entry, outfile, extra = {}) {
  console.log(`$ esbuild ${entry} -> ${outfile}`);
  buildSync({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile, // already absolute (under STAGE)
    logLevel: 'warning',
    // Load-bearing: esbuild leaves require() calls inside bundled CommonJS
    // deps (e.g. cross-spawn's require('child_process'), pulled in via
    // @sunday/mcp) as runtime __require() calls, which throw
    // 'Dynamic require … is not supported' in pure ESM output. Defining
    // require via createRequire routes those calls to the real CJS loader.
    // (Aliased import: sundayd's own sources already import createRequire.)
    banner: {
      js: "import { createRequire as __sundayCreateRequire } from 'node:module'; const require = __sundayCreateRequire(import.meta.url);",
    },
    ...extra,
  });
}
mkdirSync(join(STAGE, 'sundayd'), { recursive: true });
bundle('packages/sundayd/src/cli.ts', join(STAGE, 'sundayd/sundayd.mjs'));
bundle('packages/browserd/src/cli.ts', join(STAGE, 'sundayd/browserd.mjs'), {
  // lazy optional dep — resolved at runtime if installed
  external: ['playwright'],
});

// 2. stage the extension
mkdirSync(join(STAGE, 'dist'), { recursive: true });
{
  // The vsix is fully bundled (esbuild) — strip dev-only and workspace deps
  // so vsce/npm don't try to resolve them.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'packages/ext-agent/package.json'), 'utf8'));
  for (const [k, v] of Object.entries(manifest.dependencies ?? {})) {
    if (String(v).startsWith('workspace:')) delete manifest.dependencies[k];
  }
  delete manifest.devDependencies;
  writeFileSync(join(STAGE, 'package.json'), JSON.stringify(manifest, null, 2));
}
cpSync(join(ROOT, 'packages/ext-agent/dist/extension.cjs'), join(STAGE, 'dist/extension.cjs'));
cpSync(join(ROOT, 'packages/ext-agent/templates'), join(STAGE, 'templates'), { recursive: true });
const readme = join(ROOT, 'packages/ext-agent/README.md');
if (existsSync(readme)) cpSync(readme, join(STAGE, 'README.md'));
cpSync(join(ROOT, 'packages/ui-chat/dist'), join(STAGE, 'ui-chat/dist'), { recursive: true });
cpSync(join(ROOT, 'packages/ui-manager/dist'), join(STAGE, 'ui-manager/dist'), { recursive: true });

// 3. vsce package
const vsixName = `sunday-agent-${version}.vsix`;
sh('vsce', ['package', '--out', join(OUT, vsixName)], { cwd: STAGE });

console.log(`\nwrote ${join(OUT, vsixName)}`);
