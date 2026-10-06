/**
 * taint.ts — SEC-09: Taint tracking for untrusted content.
 *
 * Marks context that originated from untrusted sources (web fetch, files the
 * agent didn't write, MCP tool results). When tainted content was ingested in
 * the current turn, state-changing tool calls are escalated to manual approval
 * even if autonomy settings would otherwise auto-run them.
 */

/** Sources considered untrusted for taint purposes. */
export const UNTRUSTED_SOURCES = new Set([
  'web_fetch',
  'web_search',
  'mcp_tool_result',
  'file_read_untrusted', // files not written by the agent itself
  'browser_content',
]);

/** Tool calls that change state and therefore need escalation when tainted. */
export const STATE_CHANGING_TOOLS = new Set([
  'shell_exec',
  'file_write',
  'file_delete',
  'file_move',
  'git_commit',
  'git_push',
  'browser_navigate', // navigates to attacker-controlled URLs
]);

export interface TaintState {
  /** Whether untrusted content was ingested in the current turn. */
  taintedThisTurn: boolean;
  /** Which sources contributed taint this turn (for logging). */
  taintSources: string[];
}

/** Create a fresh taint state for a new turn. */
export function newTaintState(): TaintState {
  return { taintedThisTurn: false, taintSources: [] };
}

/** Mark the current turn as tainted by the given source. */
export function markTainted(state: TaintState, source: string): void {
  state.taintedThisTurn = true;
  if (!state.taintSources.includes(source)) {
    state.taintSources.push(source);
  }
}

/**
 * Decide whether a tool call needs manual approval due to taint.
 * Returns a reason string if escalation is needed, null otherwise.
 */
export function taintEscalationReason(
  state: TaintState,
  toolName: string
): string | null {
  if (!state.taintedThisTurn) return null;
  if (!STATE_CHANGING_TOOLS.has(toolName)) return null;
  return (
    `Taint escalation (SEC-09): '${toolName}' is state-changing and untrusted ` +
    `content was ingested this turn from: ${state.taintSources.join(', ')}. ` +
    `Manual approval required.`
  );
}

/** Reset taint at the start of a new turn. */
export function resetTaint(state: TaintState): void {
  state.taintedThisTurn = false;
  state.taintSources = [];
}
