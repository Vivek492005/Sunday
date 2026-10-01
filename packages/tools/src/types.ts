import type { ToolDefinition } from '@sunday/protocol';

/** Tool framework (§7). Tools are the agent's hands: the model picks them via
 *  their JSON-Schema definitions, sundayd executes them through a registry. */

export interface ToolContext {
  /** Workspace root. Every file tool is confined to this directory. */
  cwd: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Human/model-readable output (file contents, listings, command output). */
  output: string;
  isError?: boolean;
  /** Structured extras for programmatic consumers. */
  metadata?: Record<string, unknown>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function err(output: string): ToolResult {
  return { output, isError: true };
}
