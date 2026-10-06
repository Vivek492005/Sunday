# ADR-003: Zero-diff-on-vendored-VS-Code discipline

**Status:** Accepted

**Context:** Sunday vendors the full VS Code 1.140.0 source tree (~19k files) to build a branded IDE fork. Any local modification to vendored files makes future upstream merges painful and makes it unclear what Sunday actually changed.

**Decision:** The `vscode/` tree stays byte-identical to upstream except through explicitly marked patch markers (`// SUNDAY(P-xxx)`), recorded in `vscode/SUNDAY_UPSTREAM.md`. Branding is applied via `product.json` overrides and build-time asset replacement, not source edits.

**Alternatives considered:**
- *Fork-and-diverge*: Rejected — merging upstream security fixes becomes a manual nightmare.
- *No vendoring (patch at build time from upstream tarball)*: Rejected — reproducible builds need a pinned, auditable tree in-repo.

**Consequences:**
- (+) Upstream merges are mechanical: re-vendor, re-apply marked patches.
- (+) Every Sunday-specific change is greppable (`SUNDAY(`).
- (−) Some branding changes are awkward to express as build-time overrides.

**Revisit when:** Upstream VS Code changes its build/branding hooks such that the override approach stops working.
