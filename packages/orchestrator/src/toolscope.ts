import type { ToolDefinition } from '@sunday/protocol';
import { READ_ONLY_TOOLS, ToolRegistry } from '@sunday/tools';

/**
 * Tool scoping for orchestration (§9.9.1): the Orchestrator NEVER edits files.
 * Enforced BY CONSTRUCTION — the planner model call and the verifier loop are
 * only ever handed these read-only definitions, so write/exec tools
 * (write_file, edit_file, run_terminal) cannot be invoked by them even if a
 * model tried. The Feature Agent is the only role that receives the full
 * catalogue.
 */

export const ORCHESTRATOR_TOOL_NAMES: readonly string[] = [...READ_ONLY_TOOLS];

/** The verifier's tools (§9.9.7): read-only, never any write access. */
export const VERIFIER_TOOL_NAMES: readonly string[] = [...READ_ONLY_TOOLS];

/** Model-facing definitions for exactly the named tools (subset of the
 *  source registry; the source registry is never mutated). */
export function scopedToolDefinitions(
  registry: ToolRegistry,
  names: readonly string[],
): ToolDefinition[] {
  const available = new Set(registry.names());
  return names.filter((n) => available.has(n)).map((n) => registry.get(n).definition);
}

/**
 * A fresh ToolRegistry containing ONLY the named tools (the source registry
 * is never mutated). Used to build the verifier's read-only registry so the
 * verifier loop physically cannot execute a write tool.
 */
export function scopedRegistry(source: ToolRegistry, names: readonly string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of names) {
    if (source.names().includes(n)) r.register(source.get(n));
  }
  return r;
}
