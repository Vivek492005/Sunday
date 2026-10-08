import type { ToolDefinition } from '@sunday/protocol';
import type { SandboxConfig } from './sandbox.js';

/** Tool framework (§7). Tools are the agent's hands: the model picks them via
 *  their JSON-Schema definitions, sundayd executes them through a registry. */

export interface ToolContext {
  /** Workspace root. Every file tool is confined to this directory. */
  cwd: string;
  signal?: AbortSignal;
  /**
   * Sandbox execution for `run_terminal`. Stamped by sundayd from
   * `sunday.sandbox.*` (default: mode 'off' = host execution). Only
   * `run_terminal` reads this — other tools ignore it.
   */
  sandbox?: SandboxConfig;
  /**
   * LLM completion for `generate_command`. Stamped by the host (like
   * `sandbox`); given a prompt, resolves with the model's raw text reply.
   * Only `generate_command` reads this — other tools ignore it.
   */
  complete?: (prompt: string) => Promise<string>;
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
