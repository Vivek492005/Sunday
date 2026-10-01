// sundayd — workspace trust + MCP secret env conventions (Part A).
//
// The extension spawns sundayd and stamps the VS Code workspace-trust verdict
// into the environment (sidecar.ts `extraEnv`); sundayd itself is headless and
// never prompts. Trust-sensitive code paths consult `isWorkspaceTrusted()`.
//
// MCP `secret:<key>` references are resolved from `SUNDAY_MCP_SECRET_*` env
// vars: the extension pre-resolves the keys it finds in mcp.json from VS Code
// SecretStorage at spawn time (ext-agent/src/secretResolver.ts) because the
// stdio JSON-RPC protocol is client→daemon only — the daemon cannot ask the
// extension for secrets later.

/** Env var carrying the VS Code workspace-trust verdict ('1' = trusted). */
export const WORKSPACE_TRUSTED_ENV = 'SUNDAY_WORKSPACE_TRUSTED';

/** Whether this sundayd process runs in a trusted workspace. */
export function isWorkspaceTrusted(): boolean {
  return process.env[WORKSPACE_TRUSTED_ENV] === '1';
}

/**
 * Env var name carrying a pre-resolved MCP secret into sundayd.
 * Dots/dashes in keys are normalized to underscores (same mapping the
 * extension uses in ext-agent/src/secretResolver.ts — keep them in sync).
 */
export function mcpSecretEnvName(key: string): string {
  return `SUNDAY_MCP_SECRET_${key.replace(/[^A-Za-z0-9_]/g, '_')}`;
}
