/**
 * Foreign MCP configs → Sunday `mcp.json` servers.
 *
 * Understands the common `{ "mcpServers": { name: {...} } }` shape used by
 * Claude Desktop, Claude Code (~/.claude.json), Cursor, Windsurf and Cline,
 * plus MCP servers embedded in VS Code settings.json (`mcp.servers` /
 * `mcp` / `chat.mcp.discovery`).
 *
 * Secrets are never dropped silently: env values that look like raw
 * secrets are kept (so servers keep working) but flagged as
 * needs-attention, pointing at Sunday's `${secret:KEY}` references.
 */
import type {
  DetectedSource,
  SundayMcpServer,
  UnconvertibleItem,
} from './types.js';

export interface McpConversion {
  servers: Record<string, SundayMcpServer>;
  /** Server names whose env looked secret-bearing. */
  secretFlags: { server: string; keys: string[] }[];
}

interface ForeignServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
}

const SECRET_KEY_HINT = /(^|[_-])(key|token|secret|password|auth)([_-]|$)|api[_-]?key/i;

/** Extract the servers map from a parsed foreign config, whatever wrapper it uses. */
export function extractForeignServers(parsed: unknown): Record<string, ForeignServer> {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const obj = parsed as Record<string, unknown>;
  const direct = obj.mcpServers;
  if (typeof direct === 'object' && direct !== null) {
    return direct as Record<string, ForeignServer>;
  }
  // VS Code settings.json shapes.
  const mcp = obj.mcp;
  if (typeof mcp === 'object' && mcp !== null) {
    const m = mcp as Record<string, unknown>;
    if (typeof m.servers === 'object' && m.servers !== null) {
      return m.servers as Record<string, ForeignServer>;
    }
  }
  return {};
}

function toStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

function toStringMap(v: unknown): Record<string, string> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

/** Convert one foreign server entry. Returns null when unusable. */
export function convertForeignServer(name: string, entry: ForeignServer): {
  server: SundayMcpServer;
  secretKeys: string[];
} | null {
  const env = toStringMap(entry.env) ?? undefined;
  const headers = toStringMap(entry.headers) ?? undefined;

  const secretKeys: string[] = [];
  if (env) {
    for (const k of Object.keys(env)) {
      if (SECRET_KEY_HINT.test(k)) secretKeys.push(k);
    }
  }

  if (typeof entry.url === 'string' && entry.url.trim()) {
    return {
      server: {
        transport: 'http',
        url: entry.url,
        ...(headers ? { headers } : {}),
        ...(env ? { env } : {}),
        enabled: true,
        defaultApproval: 'ask',
      },
      secretKeys,
    };
  }
  if (typeof entry.command === 'string' && entry.command.trim()) {
    const args = toStringArray(entry.args) ?? [];
    return {
      server: {
        transport: 'stdio',
        command: [entry.command, ...args],
        ...(env ? { env } : {}),
        enabled: true,
        defaultApproval: 'ask',
      },
      secretKeys,
    };
  }
  return null;
}

/** Convert a whole foreign config file's servers. */
export function convertMcpConfig(source: DetectedSource, parsed: unknown): {
  conversion: McpConversion;
  unconvertible: UnconvertibleItem[];
} {
  const unconvertible: UnconvertibleItem[] = [];
  const servers: Record<string, SundayMcpServer> = {};
  const secretFlags: { server: string; keys: string[] }[] = [];

  const foreign = extractForeignServers(parsed);
  for (const [name, entry] of Object.entries(foreign)) {
    const converted = convertForeignServer(name, entry);
    if (!converted) {
      unconvertible.push({
        source: source.label,
        item: `MCP server "${name}"`,
        reason: 'Has neither a usable "command" nor a "url" — skipped.',
      });
      continue;
    }
    servers[name] = converted.server;
    if (converted.secretKeys.length > 0) {
      secretFlags.push({ server: name, keys: converted.secretKeys });
    }
  }
  return { conversion: { servers, secretFlags }, unconvertible };
}

/** Build needs-attention items for secret-bearing env vars. */
export function mcpSecretAttentionItems(source: DetectedSource, conv: McpConversion): UnconvertibleItem[] {
  return conv.secretFlags.map(({ server, keys }) => ({
    source: source.label,
    item: `MCP server "${server}" env: ${keys.join(', ')}`,
    reason:
      'Values were copied verbatim so the server keeps working, but Sunday ' +
      'prefers secrets as references — move them to your secret store and use ' +
      '`${secret:KEY}` in ~/.sunday/mcp.json.',
  }));
}

const MCP_KINDS = new Set([
  'mcp-claude-desktop',
  'mcp-claude-code',
  'mcp-cursor-user',
  'mcp-cursor-workspace',
  'mcp-windsurf',
  'mcp-cline-workspace',
  'mcp-vscode-settings',
]);

export function isMcpSource(kind: string): boolean {
  return MCP_KINDS.has(kind);
}

/** Try JSON.parse; null on failure. */
export function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
