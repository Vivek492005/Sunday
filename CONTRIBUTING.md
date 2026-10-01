# Contributing to Sunday

## Setup

Node ≥ 22, pnpm 9.

```sh
pnpm install
pnpm -r --workspace-concurrency=1 build
pnpm -r --workspace-concurrency=1 test
```

Build sequentially: parallel `tsc` runs OOM on small VMs.

## Conventions

- **TypeScript strict**, ESM (`"type": "module"`), `.js` import suffixes.
- **zod** schemas for every JSON-RPC method in `@sunday/protocol`; methods are
  registered in the central `METHODS`/`NOTIFICATIONS` registries.
- **Tests are mandatory** for new tools, protocol methods, and policy changes.
  Run the affected package's suite plus `sundayd` — it integrates everything.
- **Upstream edits** (anything under `vscode/` outside `sunday/`): register in
  `patches/PATCHES.md` with a `// SUNDAY(P-xxx)` marker in code. Keep the
  divergence budget: < 25 registered patches, < 1500 changed lines, < 60 files.
- **Commits**: one logical change per commit (`Phase N: …` for plan phases).

## Release process (0.1.x)

1. Bump versions, update `CHANGELOG.md`.
2. `node scripts/package-vsix.mjs` — must produce a working `.vsix`
   (smoke-test the bundled `sundayd` with `sunday/hello`).
3. Push + tag `v0.1.x`. The `windows-package` workflow builds the installer
   `.exe` on `windows-latest` and attaches both artifacts to the GitHub release.
4. Verify the release artifacts before announcing.

## Benchmarks

`pnpm --filter @sunday/eval eval` runs the 10-task harness (no API keys needed).
For live-model numbers: `SUNDAY_EVAL_LIVE=1` with provider keys configured.
Record per-model baselines in the release notes.
