# Sunday Publishing Guide

How to publish Sunday's distributables: the CLI to npm and the extension to
Open VSX. Both are manual, maintainer-only steps that require tokens.

## 1. CLI → npm (`@sunday/cli`)

**Prerequisites**
- An npm account with publish rights to the `@sunday` scope.
- The package builds cleanly: `packages/sunday-cli` has `"private": false`
  and `"publishConfig": {"access": "public"}` already set.

**Steps**
1. Log in (one-time per machine):
   ```
   npm login
   ```
2. Build from the repo root (publishes the compiled `dist/`, not `src/`):
   ```
   cd packages/sunday-cli
   npx tsc -p tsconfig.json
   ```
3. Publish:
   ```
   npm publish --access public
   ```
   > pnpm users: run `pnpm publish` from `packages/sunday-cli` instead —
   > pnpm automatically rewrites the `workspace:*` dependencies
   > (`@sunday/protocol`, `@sunday/sundayd`) to their pinned versions.
   > With plain `npm publish`, verify those fields were rewritten first.
4. Verify: `npm view @sunday/cli version` shows the new version, and
   `npx -y @sunday/cli --help` runs.

**Notes**
- `dist/cli.js` carries the `#!/usr/bin/env node` shebang; the `bin` entry
  (`sunday`) is already wired.
- Always bump `version` in `packages/sunday-cli/package.json` before
  publishing — npm rejects republishing an existing version.
- Do **not** commit tokens. `npm login` stores credentials in `~/.npmrc`
  (user-local, never in the repo).

## 2. Extension → Open VSX (`sunday-agent`)

**Prerequisites (one-time)**
1. Create an account at https://open-vsx.org and claim the `sunday`
   namespace — it must match the `publisher` field in
   `packages/ext-agent/package.json` (already `sunday`).
2. Generate a token at https://open-vsx.org/user-settings/tokens.
3. Add it as a repo secret named `OPENVSX_TOKEN`
   (Settings → Secrets and variables → Actions).
4. Uncomment the `release` trigger in `.github/workflows/publish-openvsx.yml`.

**Automatic (via CI, after setup)**
- Publishing a GitHub release triggers the workflow: it rebuilds the VSIX
  with `scripts/package-vsix.mjs`, verifies the publisher metadata, and
  runs `ovsx publish` with the secret token.

**Manual (without CI)**
1. Build the VSIX from the repo root:
   ```
   pnpm install --frozen-lockfile
   pnpm -r --workspace-concurrency=1 build
   npm i -g @vscode/vsce ovsx
   node scripts/package-vsix.mjs --out dist-package
   ```
2. Publish (replace `<token>`; never paste it into a file or chat log):
   ```
   ovsx publish dist-package/sunday-agent-*.vsix -p <token>
   ```
3. Verify at https://open-vsx.org/extension/sunday/sunday-agent.

**Notes**
- Open VSX (not the Microsoft Marketplace) matches this project's licensing
  posture for a VS Code fork distributed outside Microsoft's product.
- The workflow skips publishing gracefully when `OPENVSX_TOKEN` is absent,
  so forks without the secret stay green.

## 3. Release checklist (ties into the maintainer runbook)

- [ ] Versions bumped (`ext-agent`, `sunday-cli`, tags)
- [ ] CI green on all three OSes
- [ ] VSIX + installers uploaded to the GitHub release
- [ ] `npm publish` done for `@sunday/cli`
- [ ] Open VSX workflow published (or manual `ovsx publish`)
- [ ] Landing page download links point at the new assets
- [ ] `docs/PATH_TO_10.json` Phase 5 updated
