import type { ToolDefinition } from '@sunday/protocol';
import { editFileTool, listDirTool, readFileTool, writeFileTool } from './fs-tools.js';
import { gitDiffTool, gitLogTool, gitStatusTool } from './git.js';
import { ghPrCreateTool, ghPrReviewTool } from './pr.js';
import { runTerminalTool } from './terminal.js';
import { searchTool } from './search.js';
import { validateArgs } from './validate.js';
import { err, type Tool, type ToolContext, type ToolResult } from './types.js';

/** Registry: validates arguments against each tool's JSON Schema, then runs. */

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(t: Tool): void {
    if (this.tools.has(t.definition.name)) {
      throw new Error(`tool already registered: ${t.definition.name}`);
    }
    this.tools.set(t.definition.name, t);
  }

  get(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) throw new Error(`unknown tool: ${name}`);
    return t;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Definitions in model-facing form (sent as `tools` in chat requests). */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async call(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    let tool: Tool;
    try {
      tool = this.get(name);
    } catch (e) {
      return err((e as Error).message);
    }
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return err(`invalid arguments for ${name}: expected an object`);
    }
    const args = rawArgs as Record<string, unknown>;
    const problems = validateArgs(tool.definition.parameters as Record<string, unknown>, args);
    if (problems.length) {
      return err(`invalid arguments for ${name}: ${problems.join('; ')}`);
    }
    try {
      return await tool.execute(args, ctx);
    } catch (e) {
      return err(`tool ${name} failed: ${(e as Error).message}`);
    }
  }
}

export function createDefaultTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    searchTool,
    runTerminalTool,
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    ghPrCreateTool,
    ghPrReviewTool,
  ];
}

export function createDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of createDefaultTools()) r.register(t);
  return r;
}
