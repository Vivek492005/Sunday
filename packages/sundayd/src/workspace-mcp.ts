// sundayd — per-workspace MCP hubs (Phase 8 Stage 3).
//
// A shared daemon serves multiple workspaces; each workspace gets its own
// McpHub so that:
//   - the workspace-scope mcp.json is read from THAT workspace's
//     `.sunday/mcp.json` (not the daemon's launch cwd),
//   - the workspace-scope config loads only when THAT workspace is trusted
//     (SEC-04, per-workspace),
//   - `secret:<key>` references resolve from THAT workspace's secret
//     namespace (workspace-secrets.ts), never leaking across workspaces.
//
// Hubs are created lazily on first use and their tool sync into the daemon's
// global ToolRegistry is execution-gated per workspace (see agent-tools.ts
// `adaptMcpTool`): a tool registered from workspace A's hub refuses to run
// for a session whose cwd is not under A.

import { homedir } from 'node:os';
import {
  defaultWorkspaceConfigPath,
  McpHub,
  type McpHubOptions,
  type Tool as McpTool,
} from '@sunday/mcp';
import type { Tool, ToolContext, ToolResult } from '@sunday/tools';
import { canonicalizeWorkspaceRoot, isPathWithin, isWorkspaceTrusted, workspaceTrust } from './trust.js';
import { WorkspaceSecretResolver, workspaceSecrets } from './workspace-secrets.js';

export interface WorkspaceHub {
  /** Canonicalized workspace root this hub serves. */
  root: string;
  hub: McpHub;
  /** Resolved workspace mcp.json path. */
  workspaceConfigPath: string;
  /** Trust verdict the hub was constructed with. */
  workspaceTrusted: boolean;
  /** Resolves once the MCP config is loaded and initial tools are synced. */
  ready: Promise<void>;
}

/**
 * Lazily creates and caches one McpHub per workspace root.
 *
 * NOTE: a hub captures its workspace's trust verdict at construction (the
 * McpHub API is constructor-configured). If `daemon/set-workspace-trust`
 * changes a verdict after the hub exists, the manager rebuilds the hub so
 * the new verdict takes effect.
 */
export class WorkspaceMcpManager {
  private readonly hubs = new Map<string, WorkspaceHub>();

  constructor(
    private readonly opts: {
      userConfigPath?: string;
      maxTools?: number;
      userDir?: string;
    } = {},
  ) {}

  /**
   * Get (creating if needed) the hub for a workspace root. The hub reads
   * `<root>/.sunday/mcp.json`, applies `<root>`'s trust verdict, and
   * resolves secrets from `<root>`'s namespace.
   */
  get(root: string): WorkspaceHub {
    const canonical = canonicalizeWorkspaceRoot(root);
    const existing = this.hubs.get(canonical);
    if (existing) return existing;

    const workspaceTrusted = isWorkspaceTrusted(canonical);
    const workspaceConfigPath = defaultWorkspaceConfigPath(canonical);
    const hubOpts: McpHubOptions = {
      workspaceTrusted,
      workspaceConfigPath,
      secretResolver: new WorkspaceSecretResolver(canonical, workspaceSecrets),
    };
    if (this.opts.userConfigPath !== undefined) {
      hubOpts.userConfigPath = this.opts.userConfigPath;
    }
    const hub = new McpHub(hubOpts);
    const entry: WorkspaceHub = {
      root: canonical,
      hub,
      workspaceConfigPath,
      workspaceTrusted,
      ready: hub.loadConfig().then(
        () => undefined,
        (e: Error) => {
          // MCP is additive: a broken mcp.json must not take the daemon down.
          console.error(`[sundayd] MCP config load failed for ${canonical}: ${e.message}`);
        },
      ),
    };
    this.hubs.set(canonical, entry);
    return entry;
  }

  /**
   * Rebuild the hub for a workspace (e.g. after a trust-verdict change).
   * The old hub is left for GC; callers re-sync tools afterwards.
   */
  rebuild(root: string): WorkspaceHub {
    const canonical = canonicalizeWorkspaceRoot(root);
    this.hubs.delete(canonical);
    return this.get(root);
  }

  /** All hubs created so far. */
  all(): WorkspaceHub[] {
    return [...this.hubs.values()];
  }

  /** Resolve to the hub for `workspaceRoot`, or the default hub when absent. */
  resolve(workspaceRoot: string | undefined, defaultHub: WorkspaceHub): WorkspaceHub {
    if (!workspaceRoot) return defaultHub;
    return this.get(workspaceRoot);
  }
}

/**
 * Adapt an @sunday/mcp Tool into the real registry Tool, execution-gated
 * to one workspace: the tool refuses to run for sessions whose cwd is not
 * under `workspaceRoot`. This keeps workspace A's MCP tools (and their
 * secrets, resolved through A's hub) unreachable from workspace B's agents
 * even though all tools share the daemon's global ToolRegistry.
 *
 * When `workspaceRoot` is undefined the tool is ungated (legacy
 * single-workspace behavior).
 */
export function adaptMcpToolForWorkspace(
  t: McpTool,
  adapt: (t: McpTool) => Tool,
  workspaceRoot?: string,
): Tool {
  const adapted = adapt(t);
  if (!workspaceRoot) return adapted;
  const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
  const gatedExecute = async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    // The session cwd should live under the tool's workspace. In
    // single-workspace mode (no workspace ever configured) the gate is
    // permissive — legacy sessions may use any cwd. In multi-workspace
    // mode a cross-workspace invocation is refused (fail closed), keeping
    // one workspace's MCP servers/secrets unreachable from another's agents.
    if (!isPathWithin(ctx.cwd, canonical)) {
      if (!workspaceTrust.isMultiWorkspace && !workspaceSecrets.isMultiWorkspace) {
        return adapted.execute(args, ctx);
      }
      return {
        output: `MCP tool "${adapted.definition.name}" belongs to workspace ${canonical} and cannot run in this session's workspace (${ctx.cwd})`,
        isError: true,
      };
    }
    return adapted.execute(args, ctx);
  };
  return { definition: adapted.definition, execute: gatedExecute };
}
