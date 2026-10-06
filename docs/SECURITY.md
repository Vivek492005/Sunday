# Security Policy

## Supported versions

| Version | Status |
|---|---|
| `sunday-agent` 1.0.0-beta.1 (full IDE beta) | Supported — latest release line |
| `sunday-agent` 0.1.x (extension-first dev preview) | Supported — security fixes backported |
| Pre-0.1.0 / unreleased main | Not supported — upgrade to the latest release |

Security fixes land in a patch release on `main`, then a tagged rebuild
(`windows-package` workflow) and a new signed release asset. The vendored
`vscode/` tree follows upstream VS Code tags (see `docs/UPGRADE.md`) — a
security fix in the vendored tree is picked up on the next re-vendor.

## Reporting a vulnerability

**There is no bug bounty.** Please disclose privately first.

1. Open a GitHub issue titled `[security]` with no exploit details, and state
   that you have a private report to share; a maintainer will open a private
   channel. Alternatively, if the repo has private vulnerability reporting
   enabled (Security → Advisories), use it directly.
2. Include: steps to reproduce, expected vs actual behavior, the Sunday
   version (extension version from the VS Code Extensions view, or the
   release tag).
3. We aim to acknowledge within 7 days and to ship a fix or a documented
   mitigation within 30 days for high/critical findings.

Do **not** open public proof-of-concept exploits against other users'
machines, and do not run scanners against infrastructure you do not own.

## Security boundaries

### Trusted

- **The extension host and the `sunday-agent` extension code.** Bundled
  from this repo's tagged commits; the Windows installer is built on
  GitHub Actions from the release tag — verify the tag matches before
  installing.
- **`sundayd` / `browserd` sidecars.** Spawned by the extension from the
  bundled `sundayd/sundayd.mjs` (or the explicit `sunday.sidecar.path`
  override). The JSON-RPC handshake (`sunday/hello`) negotiates the protocol
  version; a mismatch refuses to connect (`ProtocolMismatchError`) instead
  of talking to a foreign daemon.
- **User-approved tools.** Every tool call passes through the policy gate
  (`packages/sundayd/src/policy.ts`): tools are allow/deny-listed per
  autonomy level, and dangerous tools (`run_terminal`, `browser_*`, MCP
  tools, `remember`) require explicit approval before they run.

### Untrusted

- **Model output.** The model is untrusted input. Tool calls proposed by the
  model are JSON-Schema validated, workspace-confined, and policy-gated;
  approval prompts show the exact command/file diff before execution.
- **MCP servers.** Third-party code. They run out-of-process (stdio or
  Streamable HTTP), get a per-server tool cap, are listed as `mcp__server__tool`,
  and dangerous MCP tools are denied until approved per daemon session.
  MCP config secrets (`secret:<key>` in `mcp.json`) are pre-resolved from
  VS Code SecretStorage — never written into `mcp.json` or logs.
- **Tool outputs.** Terminal output, web pages, file contents are treated
  as data, never as instructions. (Injection defence is tracked as a
  hardening workstream; see `docs/RELEASE_GATES.md` for status.)
- **Web content in the agent browser.** `file://` URLs are blocked, private
  IP ranges are blocked, and the first navigation to a new origin requires
  approval. The agent browser never touches the user's real browser
  profile or stored passwords.
- **Workspace files.** Skills, rules, and workspace config load only from
  trusted workspaces. Opening an untrusted workspace caps agent autonomy
  (the `sunday.workspace.trust` command gates MCP/skill loading).

## Key practices

- **Approvals.** Destructive, out-of-policy, or network-crossing actions
  require explicit user approval. Approvals are per action, shown with full
  detail (command text, file diff), and never pre-granted silently.
- **Secret storage.**
  - Provider API keys (`OPENROUTER_API_KEY`, `GROQ_API_KEY`) live in the
    **process environment** of the VS Code / `sundayd` process. They are
    never written to session files, checkpoints, logs, or the repo.
  - MCP secrets live in **VS Code SecretStorage** (via the
    `Sunday MCP: Store Secret…` command) and are handed to `sundayd` as
    `SUNDAY_MCP_SECRET_*` env vars — in-memory only, never persisted.
- **Workspace trust.** `sundayd` confines every file tool to the workspace
  root (path traversal rejected); skills/rules/MCP servers load from a
  workspace only after the user trusts it.
- **Checkpoints.** Shadow-git checkpoints live outside the user's repos
  (`~/.sunday/…`); agent undo never rewrites project history silently;
  merges are `--no-ff` and conflicts abort loudly.
- **Supply chain.** Dependencies are pinned in `pnpm-lock.yaml`. No new
  runtime dependencies may be added without review (the 1.0-beta
  constraint set forbids unreviewed additions).
- **Terminal proxy.** Commands run with a timeout; on timeout the whole
  process tree is killed (SIGKILL on the group; `taskkill /T /F` on
  Windows) — no orphaned grandchildren.

## Out of scope for this policy

- The vendored `vscode/` tree's own vulnerabilities are upstream's
  responsibility; they are tracked via the upgrade rehearsal
  (`docs/UPGRADE.md`), not this document.
- Social engineering of the user (e.g. tricking them into approving a
  malicious command) — approvals show full detail, but the user is the
  final check.
