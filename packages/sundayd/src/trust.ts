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
//
// Phase 8 Stage 3: a shared per-user daemon serves multiple workspaces, so
// trust moves from the process-global env var to a per-workspace map keyed
// by canonicalized root path. Each attached window pushes its verdict via
// `daemon/configure` / `daemon/set-workspace-trust` after the hello handshake.

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Env var carrying the VS Code workspace-trust verdict ('1' = trusted). */
export const WORKSPACE_TRUSTED_ENV = 'SUNDAY_WORKSPACE_TRUSTED';

/**
 * Canonicalize a workspace root for map keys: resolve symlinks (best-effort
 * — falls back to the lexically resolved path when the dir doesn't exist
 * yet) so `/tmp/link/proj` and `/private/tmp/link/proj` compare equal.
 */
export function canonicalizeWorkspaceRoot(root: string): string {
  const resolved = resolve(root);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** True when `child` is the same as, or nested under, `parent`. */
export function isPathWithin(child: string, parent: string): boolean {
  const c = canonicalizeWorkspaceRoot(child);
  const p = canonicalizeWorkspaceRoot(parent);
  if (c === p) return true;
  // Ensure `parent` is a path prefix on a segment boundary.
  const withSep = p.endsWith('/') ? p : `${p}/`;
  return c.startsWith(withSep);
}

/**
 * Per-workspace trust verdicts for a shared daemon. Keyed by canonicalized
 * workspace root; lookups walk up from the queried path so a session cwd
 * nested inside a configured workspace inherits its verdict.
 *
 * Fail-closed: once any workspace is configured (multi-workspace mode), an
 * unconfigured path is UNTRUSTED. While the map is empty (single-workspace
 * mode — no `daemon/configure` was ever received) lookups fall back to the
 * legacy `SUNDAY_WORKSPACE_TRUSTED` env var.
 */
export class WorkspaceTrustStore {
  private readonly verdicts = new Map<string, boolean>();

  /** Record the trust verdict for a workspace root. */
  set(workspaceRoot: string, trusted: boolean): void {
    this.verdicts.set(canonicalizeWorkspaceRoot(workspaceRoot), trusted);
  }

  /** Remove a workspace's verdict (e.g. on explicit unconfigure). */
  delete(workspaceRoot: string): boolean {
    return this.verdicts.delete(canonicalizeWorkspaceRoot(workspaceRoot));
  }

  /** All configured workspace roots (canonicalized). */
  roots(): string[] {
    return [...this.verdicts.keys()];
  }

  /** True once at least one workspace has been configured. */
  get isMultiWorkspace(): boolean {
    return this.verdicts.size > 0;
  }

  /**
   * Look up the verdict for a path (workspace root or a nested cwd).
   * Returns the nearest configured ancestor's verdict, or undefined when
   * nothing is configured for the path.
   */
  lookup(path: string): boolean | undefined {
    let current = canonicalizeWorkspaceRoot(path);
    for (;;) {
      const verdict = this.verdicts.get(current);
      if (verdict !== undefined) return verdict;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }

  clear(): void {
    this.verdicts.clear();
  }
}

/** Module-level store: the daemon's per-workspace trust map. */
export const workspaceTrust = new WorkspaceTrustStore();

/**
 * Whether the workspace is trusted.
 *
 * - With a `root`: per-workspace lookup (ancestor walk). Configured →
 *   verdict; unconfigured → false in multi-workspace mode (fail closed),
 *   `SUNDAY_WORKSPACE_TRUSTED` env in single-workspace mode (backward compat).
 * - Without a `root`: legacy process-global `SUNDAY_WORKSPACE_TRUSTED` env
 *   check (unchanged behavior for daemon-startup paths).
 */
export function isWorkspaceTrusted(root?: string): boolean {
  if (root === undefined) {
    return process.env[WORKSPACE_TRUSTED_ENV] === '1';
  }
  const verdict = workspaceTrust.lookup(root);
  if (verdict !== undefined) return verdict;
  // No configured ancestor: fail closed in multi-workspace mode, legacy env
  // behavior while no workspace was ever configured (single-workspace mode).
  if (workspaceTrust.isMultiWorkspace) return false;
  return process.env[WORKSPACE_TRUSTED_ENV] === '1';
}

/** Record a workspace trust verdict (called by the `daemon/*` RPC handlers). */
export function setWorkspaceTrust(workspaceRoot: string, trusted: boolean): void {
  workspaceTrust.set(workspaceRoot, trusted);
}

/**
 * Env var name carrying a pre-resolved MCP secret into sundayd.
 * Dots/dashes in keys are normalized to underscores (same mapping the
 * extension uses in ext-agent/src/secretResolver.ts — keep them in sync).
 */
export function mcpSecretEnvName(key: string): string {
  return `SUNDAY_MCP_SECRET_${key.replace(/[^A-Za-z0-9_]/g, '_')}`;
}
