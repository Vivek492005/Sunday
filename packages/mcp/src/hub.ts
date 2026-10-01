import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { toolDefinitionSchema } from '@sunday/protocol';
import {
  defaultUserConfigPath,
  defaultWorkspaceConfigPath,
  loadConfigFile,
  mergeConfigs,
  NoSecretResolver,
  resolveSecretRefs,
  type McpConfig,
  type McpServerConfig,
  type SecretResolver,
} from './config.js';
import type {
  McpCallRecord,
  McpServerState,
  McpServerStatus,
  McpToolInfo,
  Tool,
  ToolContext,
} from './types.js';

/** Default cap for tools exposed directly via toTools(). */
export const DEFAULT_MAX_TOOLS = 30;
/** Bounded call-history ring. */
const MAX_HISTORY = 200;
/** Truncation for the args summary stored in call history. */
const ARGS_SUMMARY_LEN = 240;

export interface McpHubOptions {
  userConfigPath?: string;
  workspaceConfigPath?: string;
  secretResolver?: SecretResolver;
  /** Workspace-scope mcp.json is ignored unless this is true. Default false. */
  workspaceTrusted?: boolean;
}

interface ManagedServer {
  config: McpServerConfig;
  client: Client | null;
  transport: Transport | null;
  state: McpServerState;
  tools: McpToolInfo[];
  lastError?: string;
}

/** `mcp__<server>__<tool>` — the double underscore survives the snake_case regex. */
export function namespacedName(server: string, tool: string): string {
  return `mcp__${sanitizeNamePart(server)}__${sanitizeNamePart(tool)}`;
}

/** Make a name segment safe for tool names: lowercase snake_case, leading letter. */
export function sanitizeNamePart(s: string): string {
  let out = s
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(out)) out = `s_${out}`;
  return out;
}

/**
 * McpHub — lifecycle + tool routing for configured MCP servers.
 *
 * Events (on `hub.events`):
 *   - `server-state`  { name, state, lastError? }
 *   - `tools-changed` { name, toolCount }
 */
export class McpHub {
  readonly events = new EventEmitter();

  private readonly userConfigPath: string;
  private readonly workspaceConfigPath: string;
  private readonly secretResolver: SecretResolver;
  private readonly workspaceTrusted: boolean;

  private config: McpConfig = { servers: {} };
  private servers = new Map<string, ManagedServer>();
  private history: McpCallRecord[] = [];
  /** Test-injected transport factories, remembered per server for on-demand starts. */
  private factories = new Map<string, () => Transport | Promise<Transport>>();

  /** True when a workspace-scope config existed but was ignored as untrusted. */
  workspaceConfigIgnored = false;

  constructor(opts: McpHubOptions = {}) {
    this.userConfigPath = opts.userConfigPath ?? defaultUserConfigPath();
    this.workspaceConfigPath = opts.workspaceConfigPath ?? defaultWorkspaceConfigPath();
    this.secretResolver = opts.secretResolver ?? new NoSecretResolver();
    this.workspaceTrusted = opts.workspaceTrusted ?? false;
  }

  // ---------------------------------------------------------------- config

  /** Load + merge user and workspace configs into the hub. */
  async loadConfig(): Promise<McpConfig> {
    const [user, workspace] = await Promise.all([
      loadConfigFile(this.userConfigPath),
      loadConfigFile(this.workspaceConfigPath),
    ]);
    const { config, workspaceIgnored } = mergeConfigs(user, workspace, this.workspaceTrusted);
    this.workspaceConfigIgnored = workspaceIgnored;
    this.config = config;

    // Drop servers that vanished from config (stop them first).
    for (const name of [...this.servers.keys()]) {
      if (!config.servers[name]) {
        await this.stopServer(name);
        this.servers.delete(name);
      }
    }
    // Add new entries as stopped; running servers keep their live config
    // until restarted (documented: config edits apply on restart).
    for (const [name, serverCfg] of Object.entries(config.servers)) {
      const existing = this.servers.get(name);
      if (existing) {
        existing.config = existing.state === 'running' ? existing.config : serverCfg;
      } else {
        this.servers.set(name, {
          config: serverCfg,
          client: null,
          transport: null,
          state: 'stopped',
          tools: [],
        });
      }
    }
    return config;
  }

  /** The currently loaded (merged) config. */
  getConfig(): McpConfig {
    return this.config;
  }

  // ---------------------------------------------------------------- lifecycle

  private managed(name: string): ManagedServer {
    const m = this.servers.get(name);
    if (!m) throw new Error(`unknown MCP server: "${name}"`);
    return m;
  }

  /**
   * Start a server. The optional transport factory is a test hook —
   * production callers omit it and get stdio/HTTP transports from config.
   * A provided factory is remembered and reused for on-demand restarts.
   */
  async startServer(
    name: string,
    transportFactory?: () => Transport | Promise<Transport>,
  ): Promise<void> {
    const m = this.managed(name);
    if (!m.config.enabled) {
      throw new Error(`MCP server "${name}" is disabled in mcp.json`);
    }
    if (m.state === 'running') return;
    if (m.state === 'starting') return;

    m.state = 'starting';
    m.lastError = undefined;
    this.emitState(name, m);

    try {
      if (transportFactory) this.factories.set(name, transportFactory);
      const factory = transportFactory ?? this.factories.get(name);
      const transport = factory ? await factory() : await this.createTransport(name, m.config);
      const client = new Client({ name: 'sunday-mcp-hub', version: '0.1.0' });
      await client.connect(transport);
      const { tools } = await client.listTools();

      m.client = client;
      m.transport = transport;
      m.tools = this.indexTools(name, tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      })));
      m.state = 'running';
      this.emitState(name, m);
      this.events.emit('tools-changed', { name, toolCount: m.tools.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      m.lastError = message;
      m.state = 'error';
      await this.closeQuietly(m);
      this.emitState(name, m);
      throw new Error(`failed to start MCP server "${name}": ${message}`);
    }
  }

  async stopServer(name: string): Promise<void> {
    const m = this.managed(name);
    await this.closeQuietly(m);
    m.state = 'stopped';
    m.lastError = undefined;
    m.tools = [];
    this.emitState(name, m);
    this.events.emit('tools-changed', { name, toolCount: 0 });
  }

  async restartServer(name: string): Promise<void> {
    await this.stopServer(name);
    await this.startServer(name);
  }

  /** Start every enabled, non-running server. Per-server failures are recorded on status, not thrown. */
  async startAll(): Promise<void> {
    for (const [name, m] of this.servers) {
      if (!m.config.enabled || m.state === 'running' || m.state === 'starting') continue;
      try {
        await this.startServer(name);
      } catch {
        // lastError + state already recorded by startServer
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const name of [...this.servers.keys()]) {
      await this.stopServer(name);
    }
  }

  serverStatus(name: string): McpServerStatus {
    const m = this.managed(name);
    const status: McpServerStatus = {
      name,
      transport: m.config.transport,
      state: m.state,
      toolCount: m.tools.length,
    };
    if (m.lastError !== undefined) status.lastError = m.lastError;
    return status;
  }

  listServers(): McpServerStatus[] {
    return [...this.servers.keys()].map((n) => this.serverStatus(n));
  }

  /** All known tools across running servers (enabled and disabled). */
  listTools(): McpToolInfo[] {
    return [...this.servers.values()].flatMap((m) => m.tools);
  }

  // ---------------------------------------------------------------- calls

  /**
   * Call a namespaced tool (`mcp__<server>__<tool>`). Starts the server on
   * demand when it is stopped. Tool execution errors are returned as
   * `{ output, isError: true }`; unknown/disabled tools throw.
   */
  async callTool(
    namespaced: string,
    args: Record<string, unknown>,
  ): Promise<{ output: string; isError?: boolean }> {
    const startedAt = Date.now();
    const fail = (server: string, tool: string, error: string) => {
      this.recordCall({ server, tool, namespaced, args, ok: false, error, startedAt });
      return { output: error, isError: true };
    };

    const route = this.resolveServerName(namespaced); // throws on malformed/unknown server
    const m = this.managed(route);

    if (m.state !== 'running') {
      try {
        await this.startServer(route);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(route, '?', `MCP server "${route}" is not running: ${message}`);
      }
    }

    // Throws on unknown/disabled tool.
    const tool = this.resolveTool(namespaced);

    try {
      const result = await m.client!.callTool({
        name: tool.tool,
        arguments: args,
      });
      const output = formatToolContent(result.content as unknown[]);
      const isError = (result as { isError?: boolean }).isError === true;
      this.recordCall({
        server: tool.server,
        tool: tool.tool,
        namespaced,
        args,
        ok: !isError,
        // A tool-reported error has no exception; the output IS the error.
        error: isError ? output.slice(0, ARGS_SUMMARY_LEN) || '(empty error output)' : undefined,
        startedAt,
      });
      const out: { output: string; isError?: boolean } = { output };
      if (isError) out.isError = true;
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      m.lastError = message;
      this.emitState(tool.server, m);
      return fail(tool.server, tool.tool, `MCP tool "${namespaced}" failed: ${message}`);
    }
  }

  /** Call history, newest first. */
  getCallHistory(limit = 100): McpCallRecord[] {
    return this.history.slice(-Math.max(0, limit)).reverse();
  }

  // ---------------------------------------------------------------- exposure

  /**
   * Convert enabled MCP tools to `@sunday/tools`-style Tool objects.
   * Definitions carry `dangerous: true` (risk class M) so the approval flow
   * engages. Tools beyond `maxTools` are omitted here but stay callable via
   * `callTool` and discoverable via the `tool_search` meta-tool.
   */
  toTools(opts: { maxTools?: number } = {}): Tool[] {
    const maxTools = opts.maxTools ?? DEFAULT_MAX_TOOLS;
    const enabled = this.listTools()
      .filter((t) => t.enabled)
      .sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
      .slice(0, Math.max(0, maxTools));

    return enabled.map((t) => {
      const definition = toolDefinitionSchema.parse({
        name: t.namespaced,
        description: `[mcp:${t.server}] ${t.description || t.name}`,
        parameters: t.inputSchema,
        dangerous: true,
      });
      const tool: Tool = {
        definition,
        execute: async (args: Record<string, unknown>, _ctx: ToolContext) => {
          const res = await this.callTool(t.namespaced, args);
          const out: { output: string; isError?: boolean } = { output: res.output };
          if (res.isError) out.isError = true;
          return out;
        },
      };
      return tool;
    });
  }

  // ---------------------------------------------------------------- internals

  private emitState(name: string, m: ManagedServer): void {
    const payload: { name: string; state: McpServerState; lastError?: string } = {
      name,
      state: m.state,
    };
    if (m.lastError !== undefined) payload.lastError = m.lastError;
    this.events.emit('server-state', payload);
  }

  private async closeQuietly(m: ManagedServer): Promise<void> {
    const client = m.client;
    const transport = m.transport;
    m.client = null;
    m.transport = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore — we are tearing down anyway
      }
    } else if (transport) {
      try {
        await transport.close();
      } catch {
        // ignore
      }
    }
  }

  private async createTransport(name: string, cfg: McpServerConfig): Promise<Transport> {
    if (cfg.transport === 'stdio') {
      const command = cfg.command!;
      const resolvedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg.env ?? {})) {
        resolvedEnv[k] = await resolveSecretRefs(v, this.secretResolver);
      }
      return new StdioClientTransport({
        command: command[0],
        args: command.slice(1),
        cwd: cfg.cwd,
        env: { ...process.env as Record<string, string>, ...resolvedEnv },
      });
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.headers ?? {})) {
      headers[k] = await resolveSecretRefs(v, this.secretResolver);
    }
    return new StreamableHTTPClientTransport(new URL(cfg.url!), {
      requestInit: { headers },
    });
  }

  private indexTools(
    server: string,
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  ): McpToolInfo[] {
    const cfg = this.managed(server).config;
    const used = new Set<string>();
    return tools.map((t) => {
      let namespaced = namespacedName(server, t.name);
      let n = 2;
      while (used.has(namespaced)) namespaced = `${namespacedName(server, t.name)}_${n++}`;
      used.add(namespaced);
      return {
        server,
        name: t.name,
        namespaced,
        description: t.description,
        inputSchema: t.inputSchema,
        enabled: this.isToolEnabled(cfg, t.name),
      };
    });
  }

  private isToolEnabled(cfg: McpServerConfig, toolName: string): boolean {
    if (cfg.toolDenylist?.includes(toolName)) return false;
    if (cfg.toolAllowlist && !cfg.toolAllowlist.includes(toolName)) return false;
    return true;
  }

  /**
   * Map a namespaced tool name to its configured server (longest sanitized
   * `mcp__<server>__` prefix wins). Throws on malformed names or unknown
   * servers. Does not require the server to be running.
   */
  private resolveServerName(namespaced: string): string {
    if (!namespaced.startsWith('mcp__')) {
      throw new Error(`not an MCP tool name: "${namespaced}" (expected mcp__<server>__<tool>)`);
    }
    const candidates = [...this.servers.keys()]
      .map((name) => ({ name, prefix: `mcp__${sanitizeNamePart(name)}__` }))
      .filter((c) => namespaced.startsWith(c.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    if (candidates.length === 0) {
      throw new Error(`unknown MCP server for tool: "${namespaced}"`);
    }
    return candidates[0].name;
  }

  /** Resolve a namespaced tool on a running server. Throws when unknown or disabled. */
  private resolveTool(namespaced: string): { server: string; tool: string } {
    const server = this.resolveServerName(namespaced);
    const m = this.managed(server);
    const info = m.tools.find((t) => t.namespaced === namespaced);
    if (!info) throw new Error(`unknown MCP tool: "${namespaced}"`);
    if (!info.enabled) throw new Error(`MCP tool "${namespaced}" is disabled by allowlist/denylist`);
    return { server, tool: info.name };
  }

  private recordCall(rec: {
    server: string;
    tool: string;
    namespaced: string;
    args: Record<string, unknown>;
    ok: boolean;
    error?: string;
    startedAt: number;
  }): void {
    let argsSummary: string;
    try {
      argsSummary = JSON.stringify(rec.args) ?? '';
    } catch {
      argsSummary = '<unserializable args>';
    }
    if (argsSummary.length > ARGS_SUMMARY_LEN) {
      argsSummary = `${argsSummary.slice(0, ARGS_SUMMARY_LEN)}…`;
    }
    const record: McpCallRecord = {
      at: new Date().toISOString(),
      server: rec.server,
      tool: rec.tool,
      namespaced: rec.namespaced,
      argsSummary,
      ok: rec.ok,
      durationMs: Date.now() - rec.startedAt,
    };
    if (rec.error !== undefined) record.error = rec.error;
    this.history.push(record);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
  }
}

function formatToolContent(content: unknown[]): string {
  if (!Array.isArray(content) || content.length === 0) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text') {
      parts.push(String((part as { text?: unknown }).text ?? ''));
    } else {
      try {
        parts.push(JSON.stringify(part));
      } catch {
        parts.push(String(part));
      }
    }
  }
  return parts.join('\n');
}
