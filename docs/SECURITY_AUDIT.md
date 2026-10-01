# Dependency Security Audit — Sunday 0.1.0 hardening

Date: 2026-10-01. Scope: all 13 packages in this monorepo, per the committed
`pnpm-lock.yaml` (lockfileVersion 9.0, 274 locked packages).

## Method and honest limits

- **No `pnpm audit` / OSV / GitHub Advisory lookup was run.** `pnpm` is not
  installed on the build machine used for this review, and no network advisory
  database was queried. This audit is a **lockfile-based, profile-driven
  review**: every direct production dependency was enumerated from the
  lockfile's `importers` section, its package profile (maintainer, purpose,
  attack surface, version currency) was assessed, and the full transitive set
  was captured in the SBOM for future automated scanning.
- **What this does cover:** exact pinned versions of everything installed,
  separation of prod vs dev dependencies, supply-chain hygiene (lockfile
  discipline, install flags, CI configuration).
- **What this does not cover:** live CVE matching (no advisory DB queried),
  transitive-dependency code review, typosquatting/protestware behavior
  analysis, or the vendored `vscode/` upstream tree (19k files of VS Code
  source; scanned separately by upstream's own release process).
- **Reproducibility:** `node scripts/gen-sbom.mjs` regenerates
  `docs/sbom.json` (CycloneDX 1.5, 274 components with purls + SHA-512
  integrity hashes) dependency-free from the lockfile. Feed it to
  `grype`, `osv-scanner`, or `dependency-track` before each release.

## Dependency surface summary

The production attack surface is deliberately tiny. Direct production
dependencies (non-`@sunday/*`) across all 13 packages:

| Package | Prod deps | Resolved |
|---|---|---|
| protocol | zod | 3.25.76 |
| gateway | — (none) | — |
| tools | — (none) | — |
| skills | — (none) | — |
| context | — (none) | — |
| mcp | @modelcontextprotocol/sdk | 1.31.0 |
| browserd | zod | 3.25.76 |
| orchestrator | zod | 3.25.76 |
| sundayd | zod | 3.25.76 |
| ext-agent | — (none; VS Code host API only) | — |
| eval | — (none) | — |
| ui-chat | react, react-dom | 18.3.1 |
| ui-manager | react, react-dom | 18.3.1 |

Everything else (TypeScript, vitest, eslint, `@types/*`, build tooling) is
dev-only: it shapes the build/CI, never the shipped runtime.

## Per-package notes

- **zod 3.25.76** (protocol, browserd, orchestrator, sundayd): pure
  validation library — no network, no fs, no child processes. Used for RPC
  schema validation, which is exactly the right place for it. 3.x is the
  previous major (4.x exists); 3.25.76 is a late, stable 3.x. No action
  required; a 4.x migration is a low-priority, breaking-change decision.
- **@modelcontextprotocol/sdk 1.31.0** (mcp): the official Anthropic SDK —
  the correct, maintained choice for MCP client/server. Pulls in
  **express 5.2.1** (Streamable HTTP transport) and **undici**-family
  networking. Express 5.2.1 is the current v5 line; it is only bound when a
  Streamable HTTP MCP server is actually configured.
- **gateway has zero production dependencies.** The provider layer (HTTP to
  OpenRouter/Groq), quota, retry, and scheduling logic are hand-written
  TypeScript on Node builtins. This is the highest-value supply-chain
  property in the tree: the code that touches API keys and billing has no
  third-party code in its path.
- **react/react-dom 18.3.1** (ui-chat, ui-manager): render-only in VS Code
  webviews. 18.x is mature; 19.x exists. Upgrade is optional and low-risk
  either way since webviews are already origin-isolated by VS Code.
- **browserd**: `playwright` is an *optional* peer, not installed — the
  shipped sidecar uses its own CDP driver. No browser-automation dependency
  in the lockfile.
- **esbuild** (transitive, dev): ships platform-specific native binaries
  (`@esbuild/*` entries in the SBOM). It is build-time only and pinned, but
  native-binary packages deserve a second look on every major bump — verify
  the published hashes against the lockfile when upgrading.

## Supply-chain hygiene

- `pnpm-lock.yaml` is committed and in sync with all `package.json` files.
- CI (`windows-package.yml`) runs `pnpm install` with `pnpm/action-setup@v4`.
  GitHub Actions sets `CI=true`, under which pnpm treats installs as
  frozen-lockfile: a PR that changes dependencies without updating the
  lockfile fails the build instead of silently resolving new versions.
- Integrity hashes (`sha512-…`) are recorded for all 274 locked packages
  and reproduced in `docs/sbom.json`.

## Audit findings

| ID | Finding | Severity | Status |
|---|---|---|---|
| DEP-01 | No automated advisory scanning in CI (no `pnpm audit` / osv-scanner step) | Medium | **Open** — SBOM is generated (`scripts/gen-sbom.mjs`); recommend adding an `osv-scanner` or `grype` step on `docs/sbom.json` to the release workflow. |
| DEP-02 | zod 3.x while 4.x is current | Low | Accepted — 3.25.76 is stable and late in the 3.x line; migration is breaking and not security-driven. |
| DEP-03 | react 18.x while 19.x is current | Low | Accepted — webview-only, origin-isolated by the host. |
| DEP-04 | Vendored `vscode/` tree excluded from this audit | Info | Documented — upstream release process applies; Sunday patches to it should be listed in `vscode/SUNDAY_UPSTREAM.md`. |

## Recommendation

Add one CI step before release: `osv-scanner --lockfile=pnpm-lock.yaml`
(or scan `docs/sbom.json` with grype) and fail on HIGH/CRITICAL. The SBOM
generator makes this a five-line addition; DEP-01 stays open until it lands.
