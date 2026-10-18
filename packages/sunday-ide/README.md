# @sunday/ide — Sunday's Own IDE Shell

**Sunday's custom IDE interface. Zero VS Code workbench UI.** VS Code supplies
only the underlying engine (Monaco text-editing surface); every pixel of the
interface — title bar, activity rail, explorer, tabs, status bar, welcome page —
is Sunday's own design in the Sunday Dark theme.

## Architecture

```
packages/sunday-ide/
├── electron/
│   ├── main.ts      # Frameless BrowserWindow, IPC (window/dialog/fs/watch/git)
│   └── preload.ts   # contextBridge → window.sunday (typed API)
├── scripts/
│   ├── build-electron.mjs  # esbuild: electron → dist-electron/
│   └── dev-electron.mjs    # dev launcher (builds electron, starts with SUNDAY_DEV=1)
├── src/
│   ├── main.tsx / App.tsx        # React entry + shell layout
│   ├── state/ideStore.tsx        # global UI state (tabs, folder, sidebar…)
│   ├── components/
│   │   ├── TitleBar.tsx          # custom menus + window controls
│   │   ├── ActivityBar.tsx       # Sunday icon rail (Explorer live, rest "soon")
│   │   ├── Sidebar/Explorer.tsx  # custom file tree (lazy, create/rename/delete)
│   │   ├── Editor/EditorArea.tsx # custom tabs + Monaco (sunday-dark theme)
│   │   ├── Editor/WelcomePage.tsx# "Your AI-native IDE." hero
│   │   └── StatusBar.tsx         # signature yellow bar
│   ├── services/
│   │   ├── fileService.ts  # typed window.sunday bridge
│   │   ├── languageMap.ts  # extension → Monaco language + tree badges
│   │   └── monacoSetup.ts  # Monaco workers + sunday-dark theme
│   └── theme/sunday.css    # Sunday design tokens, no VS Code classes
```

## Scripts

| Script       | What it does                                              |
|--------------|-----------------------------------------------------------|
| `pnpm dev`   | Vite dev server + Electron (frameless window)             |
| `pnpm build` | `vite build` (renderer → `dist/`) + electron → `dist-electron/` |
| `pnpm start` | Launch the production build (`electron .`)                |
| `pnpm test`  | vitest                                                    |
| `pnpm typecheck` | renderer + electron tsconfigs                          |
| `pnpm lint`  | eslint                                                    |

## Verification

Headless smoke test (used on machines without a display):

```sh
SUNDAY_SMOKE=1 xvfb-run -a ./node_modules/.bin/electron --no-sandbox .
# → SUNDAY_SMOKE_RESULT=PASS  (DOM shell check + IPC fs round-trip, zero console errors)
```

Set `SUNDAY_SMOKE_SHOT=/path/shot.png` to also capture a screenshot.

## Roadmap (out of MVP scope)

Terminal (xterm + node-pty), Search (ripgrep via IPC), Source Control (git UI),
Agent panel (ext-agent integration), Command palette, Settings UI, packaging
(electron-builder installers).
