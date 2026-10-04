# Upgrade rehearsal — vendored `vscode/` tree

The product builds **extension-first**: the `.vsix` does not compile the
vendored tree, but `vscode/` is the reference base for the future full
fork build and for the branding patches (P-001/P-002). Keeping it close
to upstream is what makes that future build cheap.

## Rehearsal results (2026-10-04)

**Partial rehearsal executed** — the full re-vendor against a *newer* tag was
not possible because **upstream has no newer stable tag yet**: `1.140.0`
exists (200), `1.141.0` and `1.142.0` return 404 from the GitHub API. The
pin is current; nothing to re-vendor against.

What *was* measured (this pass):

### Fork-vs-upstream divergence: effectively zero

Fetched upstream `1.140.0` (shallow, ~310 MB) and diffed against the
original vendor commit `1772f2e` (the fork snapshot, before P-001/P-002):

```
diff -rq --exclude=.git --exclude=.github --exclude=node_modules \
  upstream-1.140.0  vendor-1772f2e/vscode
```

**4 differences found, 0 unregistered drift:**

| # | File | Verdict |
|---|---|---|
| 1 | `.config/1espt/PipelineAutobaseliningConfig.yml` | Line-ending noise only (content identical) — ignore |
| 2 | `SUNDAY_UPSTREAM.md` | Our pin manifest (expected) |
| 3 | `sunday-upstream-tag.txt` | Our pin marker, contains `1.140.0` (expected) |
| 4 | `test/monaco/dist/` (only in upstream) | Build artifact present in the tag but not committed in the fork — not vendored, ignore |

**The fork's `sunday/main` was a clean copy of upstream `1.140.0`.**
No hidden patches, no unregistered drift. The "unknown" in the budget
table below is now resolved: fork-vs-upstream drift = 0.

### Current tree divergence (with P-001/P-002): all registered

Same diff against current `HEAD`:

- **24 differences**: 2 Sunday metadata files + `product.json` (P-001) +
  21 resource files (P-002). **Every one is a registered patch.**

### Budget scorecard (measured 2026-10-04)

| Metric | Budget | Measured | Status |
|---|---|---|---|
| Registered core patches | < 25 | 2 (P-001, P-002) | ✅ |
| Lines changed outside `sunday/` and `extensions/sunday-*` | < 1500 | **1,184** (109+/1075−; mostly `code.xpm` icon data swap) | ✅ |
| Files touched | < 60 | **23** (4 text + 19 binary) | ✅ |
| Upgrade wall-clock | ≤ 2 days | not yet rehearsed (no newer tag exists) | ⏳ |

### Remaining to flip the gate

1. Wait for upstream to cut the next stable tag (1.141.0+), then run the
   full re-vendor rehearsal (steps 1–6 above) and time it.
2. With zero unregistered drift and all patches registered, the re-vendor
   should be mechanical: fresh tree + re-apply P-001/P-002 via
   `branding/gen-assets.mjs` + product.json field swap.

## Current pin

From `vscode/SUNDAY_UPSTREAM.md`:

- Upstream: `microsoft/vscode`
- Pinned tag: **`1.140.0`** (upstream commit `07f806f9992`)
- Vendored on: 2026-10-01, from the `sunday/main` branch of the
  `Vivek492005/Sunday_VS_CODE` fork (fork history was excluded from the
  vendor copy)
- Size: ~19,300 files, ~310 MB

## Divergence budget (from `patches/PATCHES.md` §26.3)

| Metric | Budget | Current (measured 2026-10-01) |
|---|---|---|
| Registered core patches | < 25 | 2 (P-001, P-002 — registered, not yet applied in this repo) |
| Lines changed outside `sunday/` and `extensions/sunday-*` | < 1500 | **1,184** (measured 2026-10-04) |
| Files touched | < 60 | **23** (measured 2026-10-04) |
| Upgrade wall-clock | ≤ 2 days | not yet rehearsed (no newer upstream tag exists yet) |

### How the measurement was done — read this before trusting the table

The divergence that matters is **fork-snapshot vs upstream tag
`1.140.0`**. We only have the vendored tree (a snapshot of the fork's
`sunday/main` branch) plus the pin manifest — the upstream tag commit
`07f806f9992` is **not** in this repo's history (`.git/` of the fork was
excluded from the vendor copy, and no `microsoft/vscode` remote is
configured here).

**Update 2026-10-04:** the upstream tag *was* fetched this pass (shallow,
~310 MB) and diffed directly — see "Rehearsal results (2026-10-04)"
above. Fork-vs-upstream drift is **effectively zero** (4 diffs, all
expected/ignorable); current-tree divergence is **24 files, all
registered patches** (P-001, P-002). The budget rows above now carry
measured numbers. The remaining unknown is the wall-clock for a
re-vendor against a *newer* tag, which cannot be rehearsed until
upstream cuts one (1.141.0 does not exist yet as of 2026-10-04).

What we *could* measure locally (still useful as a cheap check):

```sh
git diff --numstat 1772f2e HEAD -- vscode/ | wc -l   # → 23
```

23 files under `vscode/` have changed **since the vendor commit**
`1772f2e` — all of them the P-001/P-002 branding work (commit
`486bf5b6`), all registered in `patches/PATCHES.md`.

## Rehearsal runbook

Run this against the *next* upstream tag (e.g. 1.141.0). Do it on a
machine with ≥ 16 GB RAM and a fast disk; the tree is ~310 MB before
`node_modules`.

### 1. Fetch the upstream tag

```sh
git remote add upstream https://github.com/microsoft/vscode.git   # one-time
git fetch upstream tag <NEW_TAG> --no-tags
```

### 2. Measure divergence of the *current* vendor snapshot

In a scratch worktree (never in the main checkout):

```sh
git worktree add /tmp/upstream-<NEW_TAG> <NEW_TAG>
diff -rq --exclude=.git /tmp/upstream-<NEW_TAG> vscode/ > /tmp/divergence.txt
wc -l /tmp/divergence.txt
```

This is the real divergence number: files differing between the pinned
upstream tag and our vendored tree (modulo the intentional exclusions:
`.git/`, `.github/`, `sunday/`, `node_modules/` — filter those out of
the diff).

Triage every differing file:

- **Intentional exclusions** (`.github/`, `sunday/`, `node_modules/`) —
  expected, ignore.
- **Registered patches** (`patches/PATCHES.md`) — verify each `// SUNDAY(P-xxx)`
  marker still has its upstream anchor; re-apply onto the new tag.
- **Unregistered drift** — anything the fork's `sunday/main` added that
  isn't in `PATCHES.md`. Either register it (new P-id, marker, test) or
  drop it. Unregistered drift is how upgrades become 2-week projects.

### 3. Re-vendor

```sh
# from a fresh clone of the Sunday_VS_CODE fork at its rebased sunday/main,
# or directly from upstream + re-applied patches (prefer the latter)
rm -rf vscode
git archive <source> | tar -x -C vscode
# re-apply exclusions: .git, .github, sunday/, node_modules
```

Then update `vscode/SUNDAY_UPSTREAM.md`: new tag, new upstream commit,
new date, new file count. Commit as `vendor: VS Code <NEW_TAG> source
tree` — separate commit from any patch re-application.

### 4. Re-apply patches and run the patch inventory

For each row in `patches/PATCHES.md`:

1. Apply against the new tree (prefer re-implementing on the new code
   over forcing a stale diff).
2. Re-verify the listed **Test** column (e.g. P-001: launch + About
   dialog shows Sunday branding).
3. Update **Last verified tag**.

Delete patches upstream made redundant.

### 5. Rebuild and test

```sh
pnpm install
pnpm -r --workspace-concurrency=1 build
pnpm -r --workspace-concurrency=1 test
node scripts/package-vsix.mjs --out /tmp/rehearsal-pkg
```

The vendored tree itself is not compiled in the extension-first path;
this step validates that the product workspace still builds/tests
against the new pin.

### 6. Score the rehearsal

Record in `patches/PATCHES.md` (or a dated note under
`docs/`): files-differing count from step 2, lines changed outside
`sunday/` + `extensions/sunday-*`, files touched, wall-clock time.
Pass criteria: all four budget numbers hold. If they don't, the
rehearsal has found real work — file it as issues, don't waive it
silently (waivers need an ADR per the release gates).

## Notes

- The current `vscode/` tree was vendored from the **fork**, not from
  upstream directly. The first rehearsal should preferably re-vendor from
  upstream + re-applied patches, which also establishes the true
  baseline the budget rows above are missing.
- `git log` on the vendor commit (`1772f2e`) is the local anchor for
  "changed since vendoring" checks; the upstream tag fetch in step 1 is
  the anchor for "diverged from upstream" checks. Don't confuse the two.
