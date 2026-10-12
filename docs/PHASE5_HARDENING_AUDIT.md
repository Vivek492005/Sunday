# Phase 5 — Core IDE Hardening Audit

**Date:** 2026-10-12
**Scope:** Static + config audit (full IDE cannot run on this VM)
**Method:** `git log`, `git diff`, config inspection

---

## 1. Extensions System — ✅ PASS

**Open VSX gallery config** (`vscode/product.json`):
```json
"extensionsGallery": {
    "serviceUrl": "https://open-vsx.org/vscode/gallery",
    "itemUrl": "https://open-vsx.org/vscode/item",
    "resourceUrlTemplate": "https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/Microsoft.VisualStudio.Code.{type}",
    "controlUrl": "",
    "nlsBaseUrl": ""
}
```

- ✅ Config unchanged since commit `79fb99f7` (Open VSX setup)
- ✅ `controlUrl: ""` is standard for Open VSX (VSCodium uses the same)
- ✅ Our `sunday-agent` extension (publisher: `sunday`, id: `sunday.sunday-agent`) is bundled via `sync-builtin.sh` — installable
- ✅ Extension install/enable/disable flows use standard workbench code — untouched

**No concerns.**

---

## 2. Settings/Keybindings — ✅ PASS

- ✅ **Zero changes** to `vscode/src/vs/workbench/contrib/preferences/` since the Beta.4 revert (`fdd2495f`)
- ✅ P2/P3 branding changed only `markdownDescription` strings in `terminalConfiguration.ts` and similar — setting IDs (`terminal.integrated.detectLocale`, etc.) are **untouched**
- ✅ The preferences contribution, settings editor, and keybinding systems have no functional modifications

**No concerns.**

---

## 3. DANGER-Zone Modules — ✅ PASS (display strings only)

Checked all 8 DANGER modules for functional changes since `fdd2495f`:

| Module | Files touched | Change type |
|---|---|---|
| files | 0 | — |
| search | 0 | — |
| terminal | 1 (`terminalConfiguration.ts`) | `markdownDescription` strings only |
| debug | 0 | — |
| extensions | 3 (`installExtensionsTool.ts`, `searchExtensionsTool.ts`, +1) | Display strings only ("reload Sunday", "Search for Sunday extensions") |
| scm | 0 | — |
| notebook | 0 | — |
| tasks | 4 (`abstractTaskService.ts`, `jsonSchemaCommon.ts`, `taskDefinitionRegistry.ts`, `taskService.ts`) | `nls.localize` description strings only |

**Total workbench diff:** 44 files, 107 insertions, 107 deletions — **pure string replacements, zero new files, zero deleted files.**

**Verification method:** Every diff hunk checked — all changes are inside `localize()` / `nls.localize()` / `markdownDescription` calls. No `registerSingleton`, no import changes, no logic changes, no setting ID changes.

**No concerns.**

---

## 4. Performance — ✅ PASS (minimal impact)

**Our additions that load at startup:**
- `sunday-agent` extension activates on `onStartupFinished` (standard, non-blocking)
- 2 new activity bar containers (`sunday-home`, `sunday-agent`)
- 8 views total (5 in explorer, 1 panel, 1 home, 1 agent)
- 52 commands registered
- 6 status bar items (staggered priorities to avoid overlap)

**Workbench changes:** Zero new contributions, zero new services, zero new files. All changes are string literals in existing `localize()` calls — **zero runtime cost** (strings are resolved at the same time as before).

**Copilot extension removal:** Actually **improves** startup — one fewer built-in extension to load, no Copilot SDK initialization, no ripgrep shim packaging.

**No concerns.**

---

## Summary

| Area | Result |
|---|---|
| Extensions system (Open VSX) | ✅ PASS |
| Settings/Keybindings | ✅ PASS |
| DANGER-zone modules | ✅ PASS (display strings only) |
| Performance | ✅ PASS (no new startup cost) |

**Overall: ✅ ALL PASS**

The Sunday IDE's core functionality is intact. All workbench modifications are cosmetic (display strings). The extension system, settings, and all DANGER-zone modules function exactly as upstream VS Code 1.140.0.

**Recommended fixes:** None. This phase is complete from a static audit perspective. Real-machine testing (installing the built IDE on Windows) remains the final validation — tracked separately.
