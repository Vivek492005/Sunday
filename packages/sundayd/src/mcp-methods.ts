// sundayd — Part A RPC surface: `mcp/*` server lifecycle + `policy/*`
// approvals, registered on the daemon by the composition root (cli.ts),
// mirroring manager.ts. Handlers validate params against the protocol
// registry and return plain objects matching the result schemas.

import { ErrorCode, parseParams, type McpMethodName, type PolicyMethodName } from '@sunday/protocol';
import { loadConfigFile, type McpHub } from '@sunday/mcp';
import type { SundayDaemon } from './daemon.js';
import type { PolicyGate } from './policy.js';
import { RpcError } from './transport.js';

export interface McpMethodsOptions {
  /** Resolved workspace mcp.json path (for per-server scope detection). */
  workspaceConfigPath: string;
  /**
   * The workspace-trust verdict the daemon was spawned with
   * (SUNDAY_WORKSPACE_TRUSTED). Reported to the MCP panel; this is NOT the
   * hub's own workspaceTrusted constructor flag (always true by Design B').
   */
  workspaceTrusted: boolean;
}

type McpHandler = (params: unknown) => Promise<unknown>;

/** Register the `mcp/*` + `policy/*` methods on a daemon instance. */
export function registerMcpMethods(
  daemon: SundayDaemon,
  hub: McpHub,
  policy: PolicyGate,
  opts: McpMethodsOptions,
): void {
  /** 'workspace' when the server name is defined in the workspace mcp.json. */
  const serverScope = async (name: string): Promise<'user' | 'workspace'> => {
    try {
      const cfg = await loadConfigFile(opts.workspaceConfigPath);
      if (cfg && Object.prototype.hasOwnProperty.call(cfg.servers, name)) return 'workspace';
    } catch {
      // Unreadable workspace config — treat as user scope.
    }
    return 'user';
  };

  const toStatus = async (name: string) => {
    const s = hub.serverStatus(name);
    return { ...s, scope: await serverScope(name) };
  };

  const handlers: Record<McpMethodName | PolicyMethodName, McpHandler> = {
    'mcp/servers/list': async (params) => {
      parseParams('mcp/servers/list', params);
      const servers = await Promise.all(hub.listServers().map((s) => toStatus(s.name)));
      return {
        servers,
        workspaceConfigIgnored: hub.workspaceConfigIgnored,
        workspaceTrusted: opts.workspaceTrusted,
      };
    },
    'mcp/server/start': async (params) => {
      const { name } = parseParams('mcp/server/start', params);
      try {
        await hub.startServer(name);
      } catch (e) {
        throw toRpcError(e);
      }
      return { status: await toStatus(name) };
    },
    'mcp/server/stop': async (params) => {
      const { name } = parseParams('mcp/server/stop', params);
      // Capture tool names first: stopping clears the hub's tool index, and
      // the policy approvals for a stopped server's tools are revoked so a
      // stale registered wrapper can never run without fresh approval.
      const toolNames = hub
        .listTools()
        .filter((t) => t.server === name)
        .map((t) => t.namespaced);
      try {
        await hub.stopServer(name);
      } catch (e) {
        throw toRpcError(e);
      }
      for (const t of toolNames) policy.revoke(t);
      return { status: await toStatus(name) };
    },
    'mcp/server/restart': async (params) => {
      const { name } = parseParams('mcp/server/restart', params);
      try {
        await hub.restartServer(name);
      } catch (e) {
        throw toRpcError(e);
      }
      return { status: await toStatus(name) };
    },
    'mcp/tools/list': async (params) => {
      const { server } = parseParams('mcp/tools/list', params);
      const tools = hub
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
      const { limit } = parseParams('mcp/calls/history', params);
      return { calls: hub.getCallHistory(limit ?? 100) };
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
