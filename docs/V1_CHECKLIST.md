# ✅ Sunday IDE v1.0.0 — Release Checklist

**Rule:** Nothing is "done" until it passes the long hard test. Built is not verified — open the artifact and check inside before any release claim.

## Pre-release

- [ ] **Version bump** — `packages/ext-agent/package.json` → `1.0.0` (CI version guard will fail the build on mismatch; never rename old-version assets)
- [ ] **CHANGELOG / release notes** — `docs/RELEASE_NOTES_1.0.0.md` reviewed and final
- [ ] **Landing page** — download links updated (see Landing section below); check in incognito (GitHub Pages caches `index.html` aggressively)
- [ ] **Full CI green** — all 9 jobs on the release commit (6 checks + 3 platform builds), no `cancelled` runs from mid-build pushes
- [ ] **No stray local commits** — `git status` clean, `git log origin/main` matches local HEAD

## Artifact verification (per platform, in the built package)

- [ ] Version reads `1.0.0` (extension `package.json`, `product.json`)
- [ ] `agentSessions` / `MainThreadChatSessions` present in extension-host bundle (Beta.4 regression must never recur)
- [ ] Sunday extensions present and compiled: `sunday-agent`, `sunday-google-auth`, `theme-sunday`
- [ ] Copilot extension **absent** from `resources/app/extensions/`
- [ ] `product.json`: `nameShort`/`nameLong` = Sunday, `defaultChatAgent.chatExtensionId` = `sunday.sunday-agent`
- [ ] Sunday Dark/Light themes load; status bar is Sunday yellow in Dark
- [ ] No "VS Code" / "Copilot" visible in: welcome, settings search, chat, issue reporter, update notifications

## Runtime smoke test (real install, at least Windows)

- [ ] Installs and opens without black/loading screen
- [ ] Google sign-in works end-to-end (login modal → OAuth → token → agent authenticated)
- [ ] Sunday IDE Agent window opens, sends a message, gets a reply
- [ ] `@sunday` participant works in native chat; model picker lists 4 models
- [ ] Streak panel loads; User Guide opens with `Ctrl+Alt+G`
- [ ] Extension install from Open VSX works
- [ ] **Auto-update test:** Beta.5 install offers v1.0.0 via the update button (beta channel), downloads, verifies hash, installs

## Release

- [ ] Tag `ide-v1.0.0` pushed → release created
- [ ] All 5 assets uploaded with correct names:
  - `Sunday-UserSetup-1.0.0-win-x64.exe`
  - `Sunday-Setup-1.0.0-win-x64.exe`
  - `Sunday-1.0.0-linux-x64.tar.gz`
  - `Sunday-1.0.0-mac-arm64.dmg`
  - `sunday-agent-1.0.0.vsix`
- [ ] Each asset download link returns HTTP 200
- [ ] Release notes published on the release page
- [ ] `docs/PROGRESS.json` updated via `scripts/update-progress.py`

## Post-release

- [ ] Landing page shows v1.0.0 as latest (incognito check)
- [ ] Auto-update from Beta.5 → v1.0.0 confirmed working on a real machine
- [ ] Announce (LinkedIn post + banner in `branding/`)

## Landing page updates needed for v1.0

In `landing/` (GitHub Pages source):
- `index.html:120` — hero download button: `ide-v1.0.0-beta.1/...beta.1...` → `ide-v1.0.0/...1.0.0...`
- `index.html:428` — version label "v1.0.0-beta.1" → "v1.0.0"
- `index.html:430` — Windows download card → v1.0.0 URL
- `index.html:433` — Linux download card → v1.0.0 URL
- `index.html:436` — macOS download card → v1.0.0 URL
- `index.html:443` — "What's New in v1.0.0-beta.1" heading → v1.0.0 (rewrite section from `docs/RELEASE_NOTES_1.0.0.md`)
- `release-notes.html:93` — tag link `ide-v1.0.0-beta.1` → `ide-v1.0.0`
- `release-notes.html` — add v1.0.0 entry (or link to the GitHub release)
- After deploy: verify in **incognito** (Pages caches old `index.html`); consider cache-bust query params on CSS/JS if stale
