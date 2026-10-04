# Sunday Electron Smoke Tests

Minimal end-to-end verification that the packaged `sunday-agent` VSIX works
inside a real VS Code window. Runs against **stock VS Code + VSIX** (the
extension-first strategy) — no full Sunday IDE build required.

## What it verifies

| # | Check | How |
|---|-------|-----|
| 1 | VS Code window opens | The suite runs at all |
| 2 | `sunday.sunday-agent` activates | `ext.isActive` after `onStartupFinished` |
| 3 | Smoke API exposed | `ext.exports.__sundaySmoke` present |
| 4 | sundayd sidecar spawns & ready | `getSidecarStatus() === 'ready'` (90s timeout) |
| 5 | RPC roundtrip | `getServerInfo()` non-null — proves `sunday/hello` handshake |
| 6 | Commands registered | `sunday.chat.focus`, `sunday.sidecar.status`, `sunday.manager.open` |

No provider API keys needed — no model calls are made. The `sunday/hello`
handshake is the RPC roundtrip proof.

## Running locally

```bash
# 1. Build the extension + package the VSIX
pnpm -r build
node scripts/package-vsix.mjs --out dist-package

# 2. Install smoke deps (one time)
cd scripts/smoke && npm install && cd ../..

# 3. Run (Linux needs xvfb)
node scripts/smoke/src/run.mjs --vsix dist-package/sunday-agent-0.1.0.vsix
# Linux: xvfb-run -a node scripts/smoke/src/run.mjs --vsix dist-package/sunday-agent-0.1.0.vsix
```

VS Code 1.140.0 is downloaded automatically (matches the extension's
`engines.vscode`). Override with `--vscode-version <x.y.z>`.

## CI

`windows-package.yml` runs the smoke suite after packaging the VSIX
(Windows runners have a display; no xvfb needed).

## Files

- `src/run.mjs` — downloads VS Code, installs the VSIX, launches the suite
- `src/suite.mjs` — checks executed inside the extension host
- `package.json` — `@vscode/test-electron` dependency
