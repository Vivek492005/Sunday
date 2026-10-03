// sundayd — per-workspace MCP secret stores (Phase 8 Stage 3).
//
// A shared daemon serves multiple workspaces. Secrets must never cross
// workspace boundaries: workspace A's `secret:<key>` must not resolve when
// operating in workspace B. Each attached window ships its secrets via
// `mcp/secrets/provide { workspaceRoot, secrets }`; the daemon keeps them
// in per-workspace namespaces.
//
// Fail-closed, mirroring trust.ts: once any workspace provides secrets
// (multi-workspace mode), a workspace without provided secrets resolves
// NOTHING — not even the legacy `SUNDAY_MCP_SECRET_*` env vars, which were
// stamped by whichever window spawned the daemon first. While no workspace
// has provided secrets (single-workspace mode) the resolver falls back to
// the env vars (backward compat).

import { dirname } from 'node:path';
import type { SecretResolver } from '@sunday/mcp';
import { canonicalizeWorkspaceRoot, mcpSecretEnvName } from './trust.js';

/**
 * Per-workspace secret namespaces. Keyed by canonicalized workspace root;
 * lookups walk up from the queried path so a session cwd nested inside a
 * configured workspace inherits its secrets.
 */
export class WorkspaceSecretStore {
  private readonly namespaces = new Map<string, Map<string, string>>();

  /**
   * Store secrets for a workspace. Keys are normalized with the same
   * mapping as `mcpSecretEnvName` (dots/dashes → underscores); values are
   * stored verbatim. Replaces any previous secrets for the workspace.
   */
  provide(workspaceRoot: string, secrets: Record<string, string>): number {
    const ns = new Map<string, string>();
    for (const [key, value] of Object.entries(secrets)) {
      ns.set(key.replace(/[^A-Za-z0-9_]/g, '_'), value);
    }
    this.namespaces.set(canonicalizeWorkspaceRoot(workspaceRoot), ns);
    return ns.size;
  }

  /** Remove a workspace's secrets. */
  delete(workspaceRoot: string): boolean {
    return this.namespaces.delete(canonicalizeWorkspaceRoot(workspaceRoot));
  }

  /** True once any workspace has provided secrets. */
  get isMultiWorkspace(): boolean {
    return this.namespaces.size > 0;
  }

  /**
   * Resolve a secret key for a path (workspace root or nested cwd).
   * Returns undefined when the key is not available to that workspace.
   */
  resolve(path: string, key: string): string | undefined {
    const normalized = key.replace(/[^A-Za-z0-9_]/g, '_');
    let current = canonicalizeWorkspaceRoot(path);
    for (;;) {
      const ns = this.namespaces.get(current);
      if (ns !== undefined) {
        // A namespace exists for this ancestor: the key either resolves
        // here or nowhere (never fall through to another workspace's).
        return ns.get(normalized);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    // No namespace on the path: in single-workspace mode fall back to the
    // legacy env vars; in multi-workspace mode resolve nothing (fail closed).
    if (!this.isMultiWorkspace) {
      return process.env[mcpSecretEnvName(key)];
    }
    return undefined;
  }

  clear(): void {
    this.namespaces.clear();
  }
}

/** Module-level store: the daemon's per-workspace secret namespaces. */
export const workspaceSecrets = new WorkspaceSecretStore();

/**
 * SecretResolver bound to one workspace root. Resolves from that
 * workspace's namespace (via `mcp/secrets/provide`), falling back to the
 * legacy `SUNDAY_MCP_SECRET_*` env vars only in single-workspace mode.
 */
export class WorkspaceSecretResolver implements SecretResolver {
  constructor(
    private readonly workspaceRoot: string,
    private readonly store: WorkspaceSecretStore = workspaceSecrets,
  ) {}

  async resolve(key: string): Promise<string> {
    const value = this.store.resolve(this.workspaceRoot, key);
    if (value === undefined) {
      throw new Error(
        `secret "${key}" is not available for workspace ${this.workspaceRoot} ` +
          `(provide it via mcp/secrets/provide or "MCP: Store Secret")`,
      );
    }
    return value;
  }
}
