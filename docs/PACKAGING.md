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

> **Note:** the extension-first distributable above remains the primary
> product path for 0.1.0. The section below is the next milestone.

## Full IDE build (fork)

This builds the actual Sunday desktop IDE from the vendored fork under
`vscode/` (VS Code 1.140.0, see `vscode/SUNDAY_UPSTREAM.md`) plus the
Sunday product code, on the **Sunday IDE** workflow
(`.github/workflows/sunday-ide.yml` — its header comment documents the
full pipeline rationale, including the gulp targets).

### How to trigger

- **Manual:** GitHub → **Actions** tab → **Sunday IDE** → **Run workflow**
  (branch: `main`). The workflow first builds + tests the product workspace
  and packages the sunday-agent VSIX, then compiles the fork.
- **On a tag push:** pushing a tag like `ide-v0.2.0` starts the same build
  and attaches the installers to the GitHub release for that tag (the
  release is created by a `prepare-release` job before the OS matrix runs).
- **Mind the two tag lines:** bare `v*` tags (e.g. `v0.1.0`) belong to
  `windows-package.yml` (the extension-only .vsix + NSIS path above).
  Full-IDE releases use `ide-v*` so the two pipelines never collide.

### What it builds (per OS)

Three matrix legs — `windows-latest` (win32 x64), `ubuntu-latest` (linux
x64), `macos-latest` (darwin arm64). Per leg, after the product build:

1. `npm ci` inside `vscode/` (upstream uses npm, NOT pnpm; Node 24.18.0
   from `vscode/.nvmrc`, enforced by vscode's preinstall script).
2. `scripts/sync-builtin.sh` stages the built sunday-agent into
   `vscode/extensions/sunday-agent/` (see "Bundling sunday-agent…" below).
3. `npm run gulp core-ci` (tsgo typecheck + esbuild min bundles) then
   `npm run gulp vscode-<platform>-<arch>-min-ci` (desktop client dir).
4. Installers:
   - **Windows:** `SundaySetup-x64-<ver>.exe` (system) and
     `SundayUserSetup-x64-<ver>.exe` (user) via Inno Setup — the `innosetup`
     npm package, so no `choco` install step is needed.
   - **Linux:** `sunday-linux-x64-<ver>.tar.gz` (plain tarball of the
     client dir; `.deb`/`.rpm` packaging is future work).
   - **macOS:** `Sunday-darwin-arm64-<ver>.dmg` via `build/darwin/create-dmg.ts`.

All installers ship **unsigned** (no certificates in the repo — see
`TODO(signing)` in the workflow header; the macOS DMG will trigger a
Gatekeeper warning on first launch).

### Where artifacts land

On the workflow run's page (**Actions** → the **Sunday IDE** run →
**Artifacts**): one artifact per OS leg, named
`sunday-ide-win32-x64-<ver>`, `sunday-ide-linux-x64-<ver>`, and
`sunday-ide-darwin-arm64-<ver>`. Each also carries the sunday-agent
`.vsix` and that leg's build log. On `ide-v*` tag runs the installers are
additionally uploaded to the tag's GitHub release (`--clobber`, all three
legs upload concurrently).

### Installing the Windows result

1. Download the Windows artifact (`sunday-ide-win32-x64-<ver>`) and run
   `SundayUserSetup-x64-<ver>.exe` (per-user) or `SundaySetup-x64-<ver>.exe`
   (machine-wide).
2. Expect a **SmartScreen "unknown publisher" warning** (unsigned) — click
   through it.
3. This is a full IDE — it does **not** require or touch an existing VS Code
   install (unlike the extension-only `Sunday-Agent-Setup-*.exe` above).
4. Launch **Sunday** → **Help → About** and confirm the product name and
   version read as Sunday, with the new icon.

### Bundling sunday-agent as a builtin extension

Before compiling the fork, CI runs `scripts/sync-builtin.sh`, which stages
the prebuilt extension into `vscode/extensions/sunday-agent/`. The fork
build then compiles it as a **built-in extension**, so it ships inside every
IDE installer — no separate install step. (The staged dir is ephemeral:
`vscode/extensions/sunday-agent/` is git-ignored and never committed.)

```sh
# after: pnpm install && pnpm -r --workspace-concurrency=1 build
node scripts/package-vsix.mjs --out dist-package   # needs `vsce` on PATH
scripts/sync-builtin.sh --vsix dist-package/sunday-agent-0.1.0.vsix
# …or without vsce, straight from the build outputs:
scripts/sync-builtin.sh --repo "$PWD" \
    --sundayd-dist "$PWD/packages/sundayd/dist" \
    --browserd-dist "$PWD/packages/browserd/dist"
```

**What the script does.** Three source modes (pick exactly one; every flag
has a `SUNDAY_*` env equivalent — see `scripts/sync-builtin.sh --help`):

- `--vsix PATH` — unpack a vsce-built `sunday-agent-*.vsix` (needs `unzip`).
- `--unpacked DIR` — stage from an already-unpacked VSIX tree.
- `--repo ROOT --sundayd-dist DIR --browserd-dist DIR` — replicate the VSIX
  staging from product build outputs: copies `ext-agent/dist`,
  `ui-chat/dist`, `ui-manager/dist`, sanitizes `package.json` (strips
  `workspace:` deps and `devDependencies`, exactly like `package-vsix.mjs`),
  and esbuild-bundles the sidecars with the same entries/options as
  `package-vsix.mjs`.

The destination defaults to `vscode/extensions/sunday-agent`
(`--dest`/`SUNDAY_DEST`; `--fork`/`SUNDAY_FORK` overrides the fork root).
Before touching the destination the script verifies the staged layout
against every runtime discovery path below, then swaps it into place
atomically (the previous content is restored if the swap fails) — the
destination is never left half-copied. Any missing input fails fast with a
named error and a non-zero exit.

**Staged layout → final IDE.**

```
vscode/extensions/sunday-agent/
  package.json              extension manifest (deps sanitized)
  dist/extension.cjs        extension host bundle (package.json "main")
  ui-chat/dist/             chat webview
  ui-manager/dist/          manager webview
  sundayd/sundayd.mjs       sundayd sidecar  (esbuild ESM bundle)
  sundayd/browserd.mjs      browserd child   (esbuild ESM bundle, playwright external)
```

The fork build picks this up with no registration step:
`vscode/build/lib/extensions.ts` globs `extensions/*/package.json`, so any
folder with a manifest is packaged. In the installed IDE it lands at
`<install>/resources/app/extensions/sunday-agent/`.

**How the runtime finds sundayd/browserd**
(`packages/ext-agent/src/sidecar.ts`, `packages/sundayd/src/browserd.ts`,
`chatView.ts`, `managerView.ts`; the `sunday.sidecar.path` / `browserdPath`
settings override everything):

- sundayd: `<ext>/sundayd/sundayd.mjs` → `<ext>/sundayd/dist/cli.js` →
  `<ext>/sundayd/cli.js` → workspace → PATH. The staged `sundayd.mjs` hits
  the first candidate.
- browserd: `<sundaydDir>/browserd.mjs` → `<ext>/browserd/dist/cli.js` →
  PATH. The staged `sundayd/browserd.mjs` hits the first candidate.
- webviews: `<ext>/ui-chat/dist`, `<ext>/ui-manager/dist` (must contain
  `index.html`).
- Both bundles are ESM run with the IDE's own node — no separate Node
  install needed. They carry a `createRequire` banner so `require()` calls
  inside bundled CommonJS deps (e.g. cross-spawn's `require('child_process')`,
  pulled in via `@sunday/mcp`) resolve against the real CJS loader instead
  of throwing `Dynamic require … is not supported` in pure ESM output.

**Fork-build notes.**

- Desktop builds include the extension automatically. Web builds skip it:
  it is a node-only extension (no `browser` entry in the manifest, and the
  sidecars need node), so `scanBuiltinExtensions`/`isWebExtension` filters it
  out — expected, not a bug.
- The staged tree passes vsce's default ignore set: no `src/`, `out/`, or
  `node_modules` is staged, so the fork's `vsce.listFiles` packaging step
  keeps every file.
- CI must smoke-test the staged sidecars **before** the fork compile — a
  broken bundle otherwise surfaces only at IDE runtime:

```sh
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' \
  | node vscode/extensions/sunday-agent/sundayd/sundayd.mjs
printf 'not-json\n' | node vscode/extensions/sunday-agent/sundayd/browserd.mjs
# browserd answers {"error":{"code":-32700,…}} on garbage input when healthy
```
