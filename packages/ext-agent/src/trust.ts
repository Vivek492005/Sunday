// sunday-agent — workspace-trust approval prompts (Part A).
//
// vscode-free by design: the VS Code API surface is injected so this module
// is unit-testable without the vscode mock.

/**
 * Env var carrying the workspace-trust verdict into the sundayd sidecar.
 * Must stay in sync with sundayd's `isWorkspaceTrusted`
 * (packages/sundayd/src/trust.ts).
 */
export const WORKSPACE_TRUSTED_ENV = 'SUNDAY_WORKSPACE_TRUSTED';

/**
 * Env var carrying the workspace root into the sundayd sidecar.
 * Must stay in sync with the daemon's workspaceDir plumbing.
 */
export const WORKSPACE_ENV = 'SUNDAY_WORKSPACE';

/** The VS Code surface this module needs (a subset of the real API). */
export interface TrustPrompt {
  /** vscode.workspace.isTrusted — false in Restricted Mode. */
  isWorkspaceTrusted: () => boolean;
  /** vscode.window.showWarningMessage. */
  showWarningMessage: (message: string, ...items: string[]) => Promise<string | undefined>;
}

/**
 * Approval prompt for enabling a workspace-scope MCP server while the
 * workspace is untrusted. Trusted workspaces (or an explicit session
 * override) skip the prompt. Returns true on Allow.
 */
export async function confirmWorkspaceMcpServer(
  prompt: TrustPrompt,
  serverName: string,
): Promise<boolean> {
  if (prompt.isWorkspaceTrusted()) return true;
  const choice = await prompt.showWarningMessage(
    `MCP server "${serverName}" is defined in the workspace .sunday/mcp.json, but the workspace is ` +
      `not trusted. Starting it will execute workspace-configured code. Allow?`,
    'Allow',
    'Deny',
  );
  return choice === 'Allow';
}

/**
 * Approval prompt for letting the agent use a workspace skill that ships
 * executable scripts while the workspace is untrusted. Returns true on Allow.
 */
export async function confirmSkillWithScripts(
  prompt: TrustPrompt,
  skillName: string,
): Promise<boolean> {
  if (prompt.isWorkspaceTrusted()) return true;
  const choice = await prompt.showWarningMessage(
    `Skill "${skillName}" comes from the workspace and contains scripts, but the workspace is ` +
      `not trusted. Allow the agent to use it?`,
    'Allow',
    'Deny',
  );
  return choice === 'Allow';
}

/**
 * Approval prompt for trusting the whole workspace (MCP servers + skills
 * with scripts). Used by the "Sunday: Trust Workspace" command. Returns true
 * on Allow.
 */
export async function confirmTrustWorkspace(prompt: TrustPrompt): Promise<boolean> {
  if (prompt.isWorkspaceTrusted()) return true;
  const choice = await prompt.showWarningMessage(
    'Trust this workspace for Sunday? Workspace .sunday/mcp.json servers and workspace skills ' +
      'containing scripts will be allowed to run. The sidecar restarts to apply this.',
    'Allow',
    'Deny',
  );
  return choice === 'Allow';
}
