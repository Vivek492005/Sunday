# PATCHES.md — register of every edit to upstream files

One purpose per patch. Mark edits in code with `// SUNDAY(P-xxx): reason`.
If a patch conflicts heavily on upgrade, prefer re-implementing it against the
new code over forcing the merge. Delete patches when upstream adds an
equivalent hook.

| ID | Title | Files | Purpose | Upstream risk | Test | Added on tag | Last verified tag | Notes |
|---|---|---|---|---|---|---|---|---|
| P-001 | Product identity | `product.json` | Branding, gallery, strip keys | Low | Launch + About check | — | — | IMPLEMENTED 2026-10-03: nameShort/Long=Sunday, applicationName=sunday, dataFolderName=.sunday, fresh GUIDs for all 4 win32 AppIds + 2 darwin profile UUIDs, darwinBundleIdentifier=com.sunday.sunday, linuxIconName=sunday, urlProtocol=sunday, reportIssueUrl→Sunday repo. Test: `node -e JSON.parse` valid; key order/set unchanged; 31 fields changed, all branding-only. |
| P-002 | Icons/resources | `resources/` | Branding assets | Low | — | — | — | IMPLEMENTED 2026-10-03: `branding/gen-assets.mjs` (zero-dep) renders the Sunday "S" mark and writes sunday.ico / sunday.icns / sunday-{16,32,48,128,256,512}.png / sunday-about.png / NSIS BMPs; copies into `vscode/resources/` keeping upstream filenames (code.ico, code.icns, code.png, code.xpm, code_150x150/70x70.png, inno-big/small-{100..250}.bmp at original dims/bit-depth); VisualElementsManifest.xml ShortDisplayName→Sunday. Test: `file` on every asset = real image format; ICO/ICNS entry tables parsed; PNG zlib round-trip. Full installer/launch verification in CI. |

Divergence budget (§26.3): registered core patches < 25 · lines changed outside
`sunday/` and `extensions/sunday-*` < 1500 · files touched < 60 · upgrade ≤ 2 days.
