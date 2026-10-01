# Sunday naming (renamed from AURORA, 2026-10-01)

The design doc (`merged_step1.md`) was written when the product was called
AURORA. The final product name is **Sunday**. Mapping for all new work:

| Old (doc) | New |
|---|---|
| `aurora.*` settings/config namespace | `sunday.*` |
| `~/.aurora` data folder | `~/.sunday` |
| `aurorad` sidecar/daemon | `sundayd` |
| `aurora-agent` built-in extension | `sunday-agent` |
| `aurora/main` long-lived branch | `sunday/main` |
| `// AURORA(P-xxx)` patch markers | `// SUNDAY(P-xxx)` |
| `.aurora/` workspace dir | `.sunday/` |
| `aurora-worktrees/` | `.sunday-worktrees/` |

A full rename pass over `merged_step1.md` is still pending.

## Part A conventions (MCP + skills, 2026-10-01)

Tool and env names follow snake_case (no camelCase, no dots in tool names):

| Name | Meaning |
|---|---|
| `mcp__<server>__<tool>` | Agent-visible name of an MCP tool, e.g. `mcp__github__create_issue`. Raw MCP tool names are namespaced this way before they enter the sundayd tool registry. |
| `SUNDAY_MCP_SECRET_<KEY>` | Env var carrying a pre-resolved MCP secret into sundayd. `<KEY>` is the `secret:<key>` reference from `mcp.json` with dots/dashes → underscores (e.g. `secret:github-token` → `SUNDAY_MCP_SECRET_github_token`). |
| `SUNDAY_WORKSPACE_TRUSTED=1\|0` | Env var stamping the extension's workspace-trust verdict into the sundayd sidecar at spawn. Daemon-side `isWorkspaceTrusted()` reads it; unset counts as untrusted. |
| `SUNDAY_WORKSPACE` | Env var stamping the workspace root into sundayd (the daemon's `workspaceDir`). |

Secrets are never written inline in `mcp.json`: configs reference them as
`secret:<key>` (or `${secret:<key>}`), resolved from VS Code SecretStorage by
the extension at spawn.
