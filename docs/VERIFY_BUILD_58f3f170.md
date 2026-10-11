# Install Verification — Build 38109057843 (commit 58f3f170)

CI result: GREEN on all 3 platforms (2026-10-11). The "Verify google-auth
extension compiled" step that failed in runs 38059710970 and 38105330494 now
passes — `vscode/extensions/sunday-google-auth/out/extension.js` is built by
an explicit `npx tsc -p tsconfig.json` step (58f3f170) before core-ci.

Use this checklist on the installed build, in order. Each item maps to one of
the 2026-10-11 screenshot complaints.

## Checklist

1. **Google sign-in** — Click sign-in → Google flow completes (GitHub already
   worked). This is the fix verified by CI; only a real login proves it
   end-to-end.
2. **Login popup** — Sign-in opens a centered modal with the Sunday logo
   (ca1c26b4), not a corner notification.
3. **Agent works + models visible** — Open chat: `@sunday` participant is
   present (51d34549) and the model picker shows models instead of only
   "Auto": Llama 3.3 70B, Qwen 2.5 Coder 32B, Llama 3.1 8B Instant.
   Ask it a coding question — no "Chat setup failed".
4. **Open IDE Agent button** — Editor title bar has the "Open IDE Agent"
   button (3d28b7c1); the right-side panel is titled Sunday IDE Agent.
5. **Streak panel** — Click the streak indicator at bottom-right → a
   colorful, animated panel opens on the right (e2be49f6).
6. **Sunday theme + yellow status bar** — Select the built-in "Sunday Dark"
   theme (e8912581): status bar background is amber `#f5b942` with dark text,
   activity/title/side bars are warm dark `#201a12`/`#1a1611` — the bar reads
   as a separate yellow strip. NOTE: status-bar *height* is stock VS Code and
   cannot be enlarged by a theme.
7. **Extensions** — Search/install from Open VSX still works (unchanged,
   3f46ae75).

## Known gap — default theme (found 2026-10-11, post-build)

The Sunday theme ships built-in but was **not wired as the default**: a
fresh install with no saved settings still falls back to VS Code's
'Dark 2026'. A local, unpushed fix now sets
`ThemeSettingDefaults.COLOR_THEME_DARK = 'Sunday Dark'` and
`COLOR_THEME_LIGHT = 'Sunday Light'` in
`vscode/src/vs/workbench/services/themes/common/workbenchThemeService.ts`.
It is NOT in build 38109057843 — it needs one more push + CI run before a
fresh install opens in the Sunday theme automatically. Until then, item 6
requires picking Sunday Dark once from the theme picker (it then persists).

## Release note

Releases are managed manually (see `.github/workflows/sunday-ide.yml`):
artifacts from run 38109057843 must be downloaded and attached to a new
GitHub release. A fresh one-time PAT is needed for that step.
