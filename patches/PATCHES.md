# PATCHES.md — register of every edit to upstream files

One purpose per patch. Mark edits in code with `// SUNDAY(P-xxx): reason`.
If a patch conflicts heavily on upgrade, prefer re-implementing it against the
new code over forcing the merge. Delete patches when upstream adds an
equivalent hook.

| ID | Title | Files | Purpose | Upstream risk | Test | Added on tag | Last verified tag | Notes |
|---|---|---|---|---|---|---|---|---|
| P-001 | Product identity | `product.json` | Branding, gallery, strip keys | Low | Launch + About check | — | — | |
| P-002 | Icons/resources | `resources/` | Branding assets | Low | — | — | — | |

Divergence budget (§26.3): registered core patches < 25 · lines changed outside
`sunday/` and `extensions/sunday-*` < 1500 · files touched < 60 · upgrade ≤ 2 days.
