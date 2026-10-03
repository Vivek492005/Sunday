import { z } from 'zod';

/** MCP server state surfaced to the extension (Part A: Editor Intelligence).
 *  Mirrors @sunday/mcp's McpServerStatus plus the config scope the server
 *  came from, which the extension needs for workspace-trust prompts. */
export const mcpServerStatusSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']),
  state: z.enum(['stopped', 'starting', 'running', 'error']),
  toolCount: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  /** 'user' = ~/.sunday/mcp.json, 'workspace' = <workspace>/.sunday/mcp.json. */
  scope: z.enum(['user', 'workspace']),
});
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

/** One MCP tool (namespaced `mcp__<server>__<tool>`), as listed for the panel. */
export const mcpToolInfoSchema = z.object({
  server: z.string().min(1),
  name: z.string().min(1),
  namespaced: z.string().min(1),
  description: z.string(),
  /** After the server config's allowlist/denylist toggles. */
  enabled: z.boolean(),
});
export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>;

/** One entry of the hub's bounded call-history ring (newest last). */
export const mcpCallRecordSchema = z.object({
  at: z.string(),
  server: z.string(),
  tool: z.string(),
  namespaced: z.string(),
  argsSummary: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  durationMs: z.number(),
});
export type McpCallRecord = z.infer<typeof mcpCallRecordSchema>;

/** MCP method registry (Part A): server lifecycle, tool listing, call
 *  history — the surface behind the extension's MCP panel and the
 *  `sunday.mcp.*` commands. Same shape as the other `*_METHODS` registries:
 *  params/result zod schemas.
 *
 *  Phase 8 Stage 3: every method accepts an optional `workspaceRoot`. When
 *  present the daemon routes to that workspace's MCP hub; when absent the
 *  daemon-wide (legacy single-workspace) hub is used. */
const workspaceRootParam = { workspaceRoot: z.string().min(1).optional() };

export const MCP_METHODS = {
  'mcp/servers/list': {
    params: z.object({ ...workspaceRootParam }),
    result: z.object({
      servers: z.array(mcpServerStatusSchema),
      /** True when a workspace-scope mcp.json existed but was ignored. */
      workspaceConfigIgnored: z.boolean(),
      /** The workspace-trust value for the routed workspace. */
      workspaceTrusted: z.boolean(),
    }),
  },
  'mcp/server/start': {
    params: z.object({ name: z.string().min(1), ...workspaceRootParam }),
    result: z.object({ status: mcpServerStatusSchema }),
  },
  'mcp/server/stop': {
    params: z.object({ name: z.string().min(1), ...workspaceRootParam }),
    result: z.object({ status: mcpServerStatusSchema }),
  },
  'mcp/server/restart': {
    params: z.object({ name: z.string().min(1), ...workspaceRootParam }),
    result: z.object({ status: mcpServerStatusSchema }),
  },
  'mcp/tools/list': {
    params: z.object({ server: z.string().min(1).optional(), ...workspaceRootParam }),
    result: z.object({ tools: z.array(mcpToolInfoSchema) }),
  },
  'mcp/calls/history': {
    params: z.object({ limit: z.number().int().min(1).max(200).optional(), ...workspaceRootParam }),
    result: z.object({ calls: z.array(mcpCallRecordSchema) }),
  },
} as const;
export type McpMethodName = keyof typeof MCP_METHODS;
