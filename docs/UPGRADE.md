# Upgrade rehearsal — vendored `vscode/` tree

The product builds **extension-first**: the `.vsix` does not compile the
vendored tree, but `vscode/` is the reference base for the future full
fork build and for the branding patches (P-001/P-002). Keeping it close
to upstream is what makes that future build cheap.

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
| Lines changed outside `sunday/` and `extensions/sunday-*` | < 1500 | **unmeasured** (see below) |
| Files touched | < 60 | **unmeasured** (see below) |
| Upgrade wall-clock | ≤ 2 days | not yet rehearsed |

### How the measurement was done — read this before trusting the table

The divergence that matters is **fork-snapshot vs upstream tag
`1.140.0`**. We only have the vendored tree (a snapshot of the fork's
`sunday/main` branch) plus the pin manifest — the upstream tag commit
`07f806f9992` is **not** in this repo's history (`.git/` of the fork was
excluded from the vendor copy, and no `microsoft/vscode` remote is
configured here).

What we *could* measure locally:

```sh
git diff --numstat 1772f2e HEAD -- vscode/ | wc -l   # → 0
```

Zero files under `vscode/` have changed **since the vendor commit**
`1772f2e` — i.e. the tree is byte-identical to the fork snapshot we
vendored. That says nothing about fork-vs-upstream drift: any patches the
fork's `sunday/main` carried (e.g. the P-001/P-002 branding work, or
anything else merged into that branch) are invisible to this diff.

Fetching the upstream tag for a real diff was judged impractical in this
pass: it needs a ~310 MB tree fetch plus the tag object, and a fresh
`microsoft/vscode` remote fetch on this VM. **The true fork-vs-upstream
divergence is therefore unmeasured — the budget rows above are honest
"unknown", not zero.**

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
