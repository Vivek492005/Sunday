# SUNDAY_UPSTREAM.md — vendored VS Code base

This `vscode/` directory is a vendored copy of the VS Code (Code-OSS) source tree,
taken from the `sunday/main` branch of the `Vivek492005/Sunday_VS_CODE` fork.

- Upstream: `microsoft/vscode`
- Pinned tag: `1.140.0` (commit `07f806f9992`)
- Vendored on: 2026-10-01
- Files: ~19,300 (~310 MB)

## Excluded from the vendor copy

- `.git/` — fork history stays in the `Sunday_VS_CODE` repo
- `.github/` — upstream CI workflows (not wanted on this repo)
- `sunday/` — the fork's old nested product snapshot; superseded by this
  repo's root product workspace (`packages/`, Phase 1a+)
- `node_modules/` — never vendored

## How Sunday integrates with this tree

Sunday product code lives at the repo root (`packages/`, `patches/`,
`scripts/`, `branding/`). At IDE build time, the `sunday-ide` GitHub
workflow compiles this tree and overlays the product via
`scripts/sync-builtin.sh` — see `patches/PATCHES.md` for the minimal-patch
policy. Edits to upstream files are allowed only as registered patches
(P-001 product identity, P-002 icons/resources — implemented 2026-10-03);
record every divergence in `patches/PATCHES.md`.
