import type { ToolDefinition } from '@sunday/protocol';

/**
 * @sunday/mcp public types.
 *
 * The `Tool` / `ToolContext` / `ToolResult` shapes below are minimal
 * structural copies of `@sunday/tools`' interfaces. This package must NOT
 * depend on `@sunday/tools` (dependency-cycle rule) — worker 3 adapts these
 * into the real registry.
 */

export interface ToolContext {
  /** Workspace root. */
  cwd: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Human/model-readable output. */
  output: string;
  isError?: boolean;
  /** Structured extras for programmatic consumers. */
  metadata?: Record<string, unknown>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type McpTransportKind = 'stdio' | 'http';
export type McpServerState = 'stopped' | 'starting' | 'running' | 'error';
export type McpApproval = 'allow' | 'ask';

export interface McpServerStatus {
  name: string;
  transport: McpTransportKind;
  state: McpServerState;
  toolCount: number;
  lastError?: string;
}

export interface McpToolInfo {
  /** Configured server name (as written in mcp.json). */
  server: string;
  /** Original tool name as reported by the MCP server. */
  name: string;
  /** Namespaced name exposed to the agent: `mcp__<server>__<tool>`. */
  namespaced: string;
  description: string;
  /** JSON Schema object. */
  inputSchema: Record<string, unknown>;
  /** After allowlist/denylist toggles. */
  enabled: boolean;
}

export interface McpCallRecord {
  /** ISO-8601 timestamp. */
  at: string;
  server: string;
  tool: string;
  namespaced: string;
  /** Truncated JSON of the call arguments. */
  argsSummary: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}
