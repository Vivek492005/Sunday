// sundayd — Part A RPC surface: `mcp/*` server lifecycle + `policy/*`
// approvals, registered on the daemon by the composition root (cli.ts),
// mirroring manager.ts. Handlers validate params against the protocol
// registry and return plain objects matching the result schemas.
//
// Phase 8 Stage 3: handlers accept an optional `workspaceRoot` param and
// route to that workspace's MCP hub. Without it they use the default
// (legacy single-workspace) hub.

import { ErrorCode, parseParams, type McpMethodName, type PolicyMethodName } from '@sunday/protocol';
import { loadConfigFile, type McpHub } from '@sunday/mcp';
import type { SundayDaemon } from './daemon.js';
import type { PolicyGate } from './policy.js';
import { RpcError } from './transport.js';

/**
 * Phase 8 Stage 3: resolves the MCP hub for an optional workspace root.
 * The default hub (no workspaceRoot) preserves legacy single-workspace
 * behavior.
 */
export interface McpHubResolver {
  resolve(workspaceRoot?: string): {
    hub: McpHub;
    /** Resolved workspace mcp.json path (for per-server scope detection). */
    workspaceConfigPath: string;
    /** The workspace-trust verdict for the routed workspace. */
    workspaceTrusted: boolean;
  };
}

type McpHandler = (params: unknown) => Promise<unknown>;

/** Register the `mcp/*` + `policy/*` methods on a daemon instance. */
export function registerMcpMethods(
  daemon: SundayDaemon,
  hubs: McpHubResolver,
  policy: PolicyGate,
): void {
  /** 'workspace' when the server name is defined in the workspace mcp.json. */
  const serverScope = async (
    hub: { hub: McpHub; workspaceConfigPath: string },
    name: string,
  ): Promise<'user' | 'workspace'> => {
    try {
      const cfg = await loadConfigFile(hub.workspaceConfigPath);
      if (cfg && Object.prototype.hasOwnProperty.call(cfg.servers, name)) return 'workspace';
    } catch {
      // Unreadable workspace config — treat as user scope.
    }
    return 'user';
  };

  const toStatus = async (
    resolved: { hub: McpHub; workspaceConfigPath: string },
    name: string,
  ) => {
    const s = resolved.hub.serverStatus(name);
    return { ...s, scope: await serverScope(resolved, name) };
  };

  const handlers: Record<McpMethodName | PolicyMethodName, McpHandler> = {
    'mcp/servers/list': async (params) => {
      const { workspaceRoot } = parseParams('mcp/servers/list', params);
      const resolved = hubs.resolve(workspaceRoot);
      const servers = await Promise.all(
        resolved.hub.listServers().map((s) => toStatus(resolved, s.name)),
      );
      return {
        servers,
        workspaceConfigIgnored: resolved.hub.workspaceConfigIgnored,
        workspaceTrusted: resolved.workspaceTrusted,
      };
    },
    'mcp/server/start': async (params) => {
      const { name, workspaceRoot } = parseParams('mcp/server/start', params);
      const resolved = hubs.resolve(workspaceRoot);
      try {
        await resolved.hub.startServer(name);
      } catch (e) {
        throw toRpcError(e);
      }
      return { status: await toStatus(resolved, name) };
    },
    'mcp/server/stop': async (params) => {
      const { name, workspaceRoot } = parseParams('mcp/server/stop', params);
      const resolved = hubs.resolve(workspaceRoot);
      // Capture tool names first: stopping clears the hub's tool index, and
      // the policy approvals for a stopped server's tools are revoked so a
      // stale registered wrapper can never run without fresh approval.
      const toolNames = resolved.hub
        .listTools()
        .filter((t) => t.server === name)
        .map((t) => t.namespaced);
      try {
        await resolved.hub.stopServer(name);
      } catch (e) {
        throw toRpcError(e);
      }
      for (const t of toolNames) policy.revoke(t);
      return { status: await toStatus(resolved, name) };
    },
    'mcp/server/restart': async (params) => {
      const { name, workspaceRoot } = parseParams('mcp/server/restart', params);
      const resolved = hubs.resolve(workspaceRoot);
      try {
        await resolved.hub.restartServer(name);
      } catch (e) {
        throw toRpcError(e);
      }
      return { status: await toStatus(resolved, name) };
    },
    'mcp/tools/list': async (params) => {
      const { server, workspaceRoot } = parseParams('mcp/tools/list', params);
      const resolved = hubs.resolve(workspaceRoot);
      const tools = resolved.hub
        .listTools()
        .filter((t) => !server || t.server === server)
        .map((t) => ({
          server: t.server,
          name: t.name,
          namespaced: t.namespaced,
          description: t.description,
          enabled: t.enabled,
        }));
      return { tools };
    },
    'mcp/calls/history': async (params) => {
      const { limit, workspaceRoot } = parseParams('mcp/calls/history', params);
      const resolved = hubs.resolve(workspaceRoot);
      return { calls: resolved.hub.getCallHistory(limit ?? 100) };
    },
    'policy/approve': async (params) => {
      const { tool } = parseParams('policy/approve', params);
      policy.approve(tool);
      return { ok: true as const };
    },
    'policy/revoke': async (params) => {
      const { tool } = parseParams('policy/revoke', params);
      policy.revoke(tool);
      return { ok: true as const };
    },
    'policy/list': async (params) => {
      parseParams('policy/list', params);
      return { dangerous: policy.dangerousTools(), approved: policy.approvedTools() };
    },
  };

  for (const [method, handler] of Object.entries(handlers)) {
    daemon.registerMethod(method, handler);
  }
}

function toRpcError(e: unknown): RpcError {
  const message = e instanceof Error ? e.message : String(e);
  // Unknown/disabled servers and tools are caller errors, not daemon bugs.
  if (/^unknown MCP server|^MCP server ".+" is disabled/.test(message)) {
    return new RpcError(ErrorCode.InvalidParams, message);
  }
  return new RpcError(ErrorCode.InternalError, message);
}
