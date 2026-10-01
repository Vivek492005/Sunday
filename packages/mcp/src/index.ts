// @sunday/mcp — MCP client hub: server lifecycle, namespaced tool exposure,
// secret-safe config, call history, and the tool_search meta-tool.

export {
  McpHub,
  DEFAULT_MAX_TOOLS,
  namespacedName,
  sanitizeNamePart,
  type McpHubOptions,
} from './hub.js';

export {
  parseMcpConfig,
  loadConfigFile,
  mergeConfigs,
  resolveSecretRefs,
  defaultUserConfigPath,
  defaultWorkspaceConfigPath,
  NoSecretResolver,
  type McpConfig,
  type McpServerConfig,
  type SecretResolver,
} from './config.js';

export { createToolSearchTool } from './tool-search.js';

export type {
  Tool,
  ToolContext,
  ToolResult,
  McpTransportKind,
  McpServerState,
  McpApproval,
  McpServerStatus,
  McpToolInfo,
  McpCallRecord,
} from './types.js';
