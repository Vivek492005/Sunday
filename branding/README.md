# branding — Sunday brand assets (P-002)

Source of truth: `gen-assets.mjs` (zero-dependency Node script — run with
`node branding/gen-assets.mjs`). It renders a geometric "S" mark (amber/gold
gradient) on a dark indigo rounded square, then writes every asset below and
copies the ones the VS Code build expects into `vscode/resources/` **keeping
upstream filenames** so no build script changes are needed.

## Assets in this folder

| File | Format | Notes |
|---|---|---|
| `sunday.ico` | ICO, 16/32/48/256 (PNG-compressed entries) | Windows app icon |
| `sunday.icns` | ICNS, 16/32/64/128/256/512/1024 PNG entries | macOS app icon |
| `sunday-16/32/48/128/256/512.png` | PNG RGBA | Linux icon set |
| `sunday-about.png` | PNG RGBA 512×512 | About-dialog / product logo |
| `nsis-header-150x57.bmp` | BMP 24-bit 150×57 | NSIS header reference |
| `nsis-wizard-164x314.bmp` | BMP 24-bit 164×314 | NSIS wizard reference |

## Mapping into `vscode/resources/` (upstream filenames kept)

- `resources/win32/code.ico` ← `sunday.ico` (used by `build/lib/electron.ts`, `build/win32/code.iss` `SetupIconFile`)
- `resources/darwin/code.icns` ← `sunday.icns` (used by `build/lib/electron.ts`)
- `resources/linux/code.png` ← `sunday-256.png` (source for deb/rpm/snap icons in `build/gulpfile.vscode.linux.ts`)
- `resources/linux/rpm/code.xpm` ← regenerated 48×48 XPM (rpm spec icon)
- `resources/win32/code_150x150.png`, `code_70x70.png` ← mark at those sizes (referenced by `VisualElementsManifest.xml`)
- `resources/win32/inno-big-{100..250}.bmp`, `inno-small-{100..250}.bmp` ← regenerated at the exact original dimensions/bit-depth (`build/win32/code.iss` `WizardImageFile`/`WizardSmallImageFile`)
- `resources/win32/VisualElementsManifest.xml`: `ShortDisplayName` "Code - OSS" → "Sunday"

Language/file-type icons (`javascript.ico`, `python.icns`, …) are intentionally
untouched — they are not product branding.
