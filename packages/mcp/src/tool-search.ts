import { toolDefinitionSchema } from '@sunday/protocol';
import type { McpHub } from './hub.js';
import type { McpToolInfo, Tool } from './types.js';

/**
 * `tool_search` meta-tool. Tools beyond the `toTools()` cap are hidden from
 * the model's direct tool list; this meta-tool lets the agent discover them
 * by keyword and then call them directly (the hub resolves them on demand).
 *
 * Exported so worker 3 can register it alongside `hub.toTools()`.
 */
export function createToolSearchTool(hub: McpHub): Tool {
  const definition = toolDefinitionSchema.parse({
    name: 'tool_search',
    description:
      'Search MCP tools that are hidden behind the tool cap. ' +
      'Returns matching tools as "mcp__<server>__<tool> — description" lines; ' +
      'call a match directly afterwards.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords to match against tool names, descriptions, and server names.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  });

  return {
    definition,
    execute: async (args: Record<string, unknown>, _ctx) => {
      const query = String(args.query ?? '').trim().toLowerCase();
      if (!query) return { output: 'query is empty; no tools searched.' };

      // The boundary is whatever toTools() exposes by default.
      const direct = new Set(hub.toTools().map((t) => t.definition.name));
      const matches = hub
        .listTools()
        .filter((t) => t.enabled && !direct.has(t.namespaced))
        .map((t) => ({ tool: t, score: scoreTool(t, query) }))
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.namespaced.localeCompare(b.tool.namespaced))
        .slice(0, 20);

      if (matches.length === 0) {
        return { output: `no hidden MCP tools match "${String(args.query)}".` };
      }
      const lines = matches.map(
        ({ tool }) => `${tool.namespaced} — ${tool.description || '(no description)'}`,
      );
      return {
        output:
          `matching MCP tools (${matches.length}; call one directly with its full name):\n` +
          lines.join('\n'),
      };
    },
  };
}

function scoreTool(t: McpToolInfo, query: string): number {
  const name = t.namespaced.toLowerCase();
  const desc = t.description.toLowerCase();
  const server = t.server.toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const w of words) {
    if (name.includes(w)) score += 3;
    if (server.includes(w)) score += 2;
    if (desc.includes(w)) score += 1;
  }
  // Bonus when the whole query hits the name verbatim.
  if (name.includes(query)) score += 2;
  return score;
}
