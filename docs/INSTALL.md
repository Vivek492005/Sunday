# Install — Windows

The 0.1.0 distributable is **extension-first**: a `.vsix` containing the
extension bundle, the chat/manager webviews, and the `sundayd`/`browserd`
sidecars as esbuild ESM bundles. There are two ways to install it.

## Requirements

- **Windows 10/11 x64.**
- **VS Code ≥ 1.140.0** (`engines.vscode: ^1.140.0` in the extension
  manifest). VS Code's bundled node runs the sidecars — **no separate
  Node.js install is needed** for the extension itself.
- For **building from source** (not needed to install): Node 22
  (`@types/node ^22.10.0` in devDependencies) and pnpm. Build
  sequentially: `pnpm -r --workspace-concurrency=1 build` (parallel
  builds OOM on small machines).

## Option A — installer (recommended)

1. Download `Sunday-Agent-Setup-0.1.0.exe` from the GitHub release page.
2. **Verify the release tag** matches the commit you expect (built on
   GitHub Actions from the tag; see `SECURITY.md`).
3. Run the `.exe` (per-user install, no admin needed —
   `RequestExecutionLevel user`, installs to
   `%LOCALAPPDATA%\Programs\Sunday`).
   - If VS Code is not found (`code.cmd` on PATH or the default install
     location), the installer aborts with a message — install VS Code
     first, then re-run.
4. The installer runs `code --install-extension sunday-agent-0.1.0.vsix
   --force`.

## Option B — manual .vsix install

1. Download `sunday-agent-0.1.0.vsix` from the release page.
2. In VS Code: Extensions view (Ctrl+Shift+X) → `…` menu → **Install
   from VSIX…** → pick the file. Or from a terminal:
   `code --install-extension sunday-agent-0.1.0.vsix`.

## First run

1. Set your provider key(s) — see `docs/PROVIDER_SETUP.md`. Provider
   keys are **environment variables** (`OPENROUTER_API_KEY` /
   `GROQ_API_KEY`); set them as user env vars and **re-launch VS Code**
   before the extension can see them.
2. Open a workspace folder. On first run the extension auto-starts
   `sundayd` (`sunday.sidecar.autoStart`, default `true`); the status
   bar shows sidecar health.
3. Open the chat: `Sunday: Focus Agent Chat` (Ctrl+Shift+X → search
   "Sunday", or the Sunday activity-bar icon). Send a test message.
4. Optional: enable the agent browser (`sunday.browser.enabled: true` +
   sidecar restart), store MCP secrets
   (`Sunday MCP: Store Secret…`), trust the workspace for MCP/skills
   (`Sunday: Trust Workspace for MCP/Skills`).

## What's inside the .vsix

Built by `scripts/package-vsix.mjs` (needs `pnpm install`,
`pnpm -r build`, and `vsce` on PATH):

| Path in vsix | Source |
|---|---|
| `package.json` | `packages/ext-agent/package.json` (workspace deps stripped) |
| `dist/extension.cjs` | esbuild bundle of `packages/ext-agent/src/extension.ts` |
| `ui-chat/dist/`, `ui-manager/dist/` | vite builds of the webviews |
| `sundayd/sundayd.mjs` | esbuild ESM bundle of `packages/sundayd/src/cli.ts` |
| `sundayd/browserd.mjs` | esbuild ESM bundle of `packages/browserd/src/cli.ts` (`playwright` external, resolved at runtime if installed) |

The sidecar discovery order is: `sunday.sidecar.path` setting → bundled
`<ext>/sundayd/sundayd.mjs` → dev `packages/sundayd/dist/cli.js` →
`sundayd` on PATH (`packages/ext-agent/src/sidecar.ts`).

## Uninstall

Extensions view → Sunday Agent → Uninstall; or
`code --uninstall-extension sunday-agent`. The NSIS uninstaller does the
same. User data (`~/.sunday/` — checkpoints, orchestrations,
browser-session media) is **kept**; delete it manually if wanted.
Settings (`sunday.*`) are kept by VS Code across reinstall.
