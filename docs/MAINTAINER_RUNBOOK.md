# Sunday Maintainer Runbook

The bus-factor document: everything needed to keep Sunday alive if the
maintainer disappears.

## Secrets & keys

| Secret | Where it lives | Rotation |
|---|---|---|
| GitHub PAT | Never stored — one-time use via env passthrough, then discarded | N/A |
| OpenRouter API key | `OPENROUTER_API_KEY` env var on dev/release machines | Via provider dashboard |
| Groq API key | `GROQ_API_KEY` env var | Via provider dashboard |
| `SUNDAY_HOSTED_*` | Operator env (hosted gateway only) | Per deployment |

**Rule**: No secret is ever committed, logged, or stored in memory files.

## Cutting a release

1. Ensure `main` is green on all 3 CI platforms.
2. Bump versions: `packages/*/package.json` + root.
3. Update `CHANGELOG.md` with the release section.
4. Commit: `chore: release vX.Y.Z`.
5. Tag: `git tag vX.Y.Z && git tag ide-vX.Y.Z`.
6. Push tags — CI builds Windows/Linux/macOS artifacts.
7. Download artifacts from the CI run, rename to versioned filenames.
8. Create GitHub release, upload: 2× `.exe`, 1× `.tar.gz`, 1× `.dmg`, 1× `.vsix`.
9. Update `docs/RELEASE_GATES.md` evidence.

## CI configuration

- `.github/workflows/sunday-ide.yml` — full IDE build (3 OSes) + lint/typecheck/coverage jobs.
- `.github/workflows/windows-package.yml` — Windows installer packaging.
- `.github/workflows/deploy-landing.yml` — landing page → GitHub Pages.
- Secrets needed: none for public builds (all read-only).

## Landing page

Source: `landing/` → deployed via `deploy-landing.yml` to
`https://vivek492005.github.io/Sunday/`. Push to `main` auto-deploys.

## Key contacts & accounts

- GitHub org/user: `Vivek492005`
- License: Apache-2.0, copyright "Sunday"
- Vendored VS Code: 1.140.0, see `vscode/SUNDAY_UPSTREAM.md`

## If something breaks

1. Check CI status on the latest `main` commit.
2. `git log --oneline -10` for recent changes.
3. Soak test: `node scripts/soak-test.mjs --duration=5m`.
4. Roll back: `git revert` the suspect commit, push, CI rebuilds.
