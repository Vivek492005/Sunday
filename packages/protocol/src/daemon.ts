import { z } from 'zod';

/**
 * @sunday/protocol — per-user daemon configuration surface (Phase 8 Stage 3).
 *
 * A shared sundayd serves multiple windows/workspaces. Process-global env
 * config (`SUNDAY_WORKSPACE_TRUSTED`, `SUNDAY_MCP_SECRET_*`, …) cannot
 * express per-workspace settings, so each attached window configures its
 * own workspace via `daemon/configure` (or the narrower
 * `daemon/set-workspace-trust`) after the `sunday/hello` handshake.
 *
 * `mcp/secrets/provide` ships the window's MCP secrets to the daemon
 * scoped to its workspace — the daemon never reads another workspace's
 * secrets, and unconfigured workspaces fall back to the legacy
 * `SUNDAY_MCP_SECRET_*` env behavior only in single-workspace mode.
 */

/** Per-workspace configuration pushed by each attached client. */
export const daemonConfigureParamsSchema = z.object({
  /** Workspace root for the attaching window (canonicalized by the daemon). */
  workspaceRoot: z.string().min(1),
  /** VS Code workspace-trust verdict for this workspace. */
  trusted: z.boolean().optional(),
  /** Whether the browser agent is enabled for this workspace. */
  browserEnabled: z.boolean().optional(),
  /** Sandbox mode for `run_terminal` in this workspace. */
  sandboxMode: z.string().optional(),
  /**
   * Sunday hosted gateway token (GitHub OAuth token from the IDE sign-in).
   * Lets the daemon's gateway use the zero-config hosted provider without
   * the user copying API keys. Never logged.
   */
  sundayApiToken: z.string().min(1).optional(),
});
export type DaemonConfigureParams = z.infer<typeof daemonConfigureParamsSchema>;

export const setWorkspaceTrustParamsSchema = z.object({
  workspaceRoot: z.string().min(1),
  trusted: z.boolean(),
});
export type SetWorkspaceTrustParams = z.infer<typeof setWorkspaceTrustParamsSchema>;

export const workspaceStatusSchema = z.object({
  root: z.string(),
  trusted: z.boolean(),
});
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const provideSecretsParamsSchema = z.object({
  workspaceRoot: z.string().min(1),
  /** Secret key → value. Keys use the same normalization as
   *  `mcpSecretEnvName` (dots/dashes → underscores). */
  secrets: z.record(z.string(), z.string()),
});
export type ProvideSecretsParams = z.infer<typeof provideSecretsParamsSchema>;

/** Daemon method registry (Phase 8 Stage 3): per-workspace configuration. */
export const DAEMON_METHODS = {
  'daemon/configure': {
    params: daemonConfigureParamsSchema,
    result: z.object({ ok: z.literal(true) }),
  },
  'daemon/set-workspace-trust': {
    params: setWorkspaceTrustParamsSchema,
    result: z.object({ ok: z.literal(true), workspaceRoot: z.string() }),
  },
  'daemon/status': {
    params: z.object({}),
    result: z.object({
      /** Configured workspaces and their trust verdicts. */
      workspaces: z.array(workspaceStatusSchema),
      /** True once any workspace has been configured (multi-workspace mode). */
      multiWorkspace: z.boolean(),
    }),
  },
  'mcp/secrets/provide': {
    params: provideSecretsParamsSchema,
    result: z.object({ ok: z.literal(true), count: z.number().int().nonnegative() }),
  },
} as const;
export type DaemonMethodName = keyof typeof DAEMON_METHODS;
