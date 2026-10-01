# Packaging

## What ships in 0.1.0

- **`sunday-agent-0.1.0.vsix`** — the VS Code extension: extension host bundle,
  chat + manager webviews, and the sidecars (`sundayd/sundayd.mjs`,
  `sundayd/browserd.mjs`, esbuild ESM bundles run with VS Code's own node —
  no separate Node install needed for the extension itself).
- **`Sunday-Agent-Setup-0.1.0.exe`** — Windows installer (NSIS) that installs
  the `.vsix` into VS Code.

## Build the .vsix (any OS)

```sh
pnpm install
pnpm -r --workspace-concurrency=1 build
node scripts/package-vsix.mjs --out dist-package   # needs `vsce` on PATH
```

The script bundles `sundayd`/`browserd` with esbuild, stages the extension
layout (matching the sidecar/webview discovery paths), and runs
`vsce package`. Smoke-test the bundle:

```sh
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' \
  | node dist-package/stage/sundayd/sundayd.mjs
```

## Windows installer

`packaging/windows/sunday.nsi` — installed with NSIS (`makensis`,
preinstalled on GitHub `windows-latest` runners):

```sh
makensis /DVERSION=0.1.0 /DVSIX=dist-package/sunday-agent-0.1.0.vsix packaging/windows/sunday.nsi
```

Requires VS Code on the target machine; aborts with a clear message otherwise.
The uninstaller removes the extension via `code --uninstall-extension`.

## CI: `windows-package` workflow

`.github/workflows/windows-package.yml` — runs on `workflow_dispatch` and on
`v*` tag pushes. On `windows-latest` it installs, builds, tests, packages the
`.vsix`, builds the installer `.exe`, uploads both as artifacts, and (tags
only) creates the GitHub release with both attached.

## Full-fork builds

The vendored VS Code tree under `vscode/` is for reference and future
built-in packaging; the 0.1.0 distributable is the extension-first path
(extension + sidecars), which is what the `windows-package` workflow builds.
Fork compile + branding patches (P-001/P-002 in `patches/PATCHES.md`) are
tracked for a later release.
