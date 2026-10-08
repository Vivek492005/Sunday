/**
 * @sunday/tools — agent modes (Group B4).
 *
 * Four modes shape what the agent may do:
 * - `auto`: current default behavior — every registered tool is available.
 * - `architect`: planning only — read-only tools (plus any future
 *   plan/decompose tools); no writes, no execution.
 * - `implementer`: full tool access (same as auto, but explicit).
 * - `reviewer`: read tools + comment/diff tools only; writes are blocked
 *   with a clear denial message.
 *
 * The daemon enforces the mode in the agent loop's tool-dispatch path
 * (see sundayd `AgentLoop`); the extension selects and persists the mode
 * per workspace. `SUNDAY_AGENT_MODE` carries the mode from the extension
 * to the sidecar at spawn.
 */

import { READ_ONLY_TOOLS, WRITE_TOOLS } from './scopes.js';

// Re-exported so consumers get the canonical tool scopes from one place.
export { READ_ONLY_TOOLS, WRITE_TOOLS };

/** The four agent modes. */
export type AgentMode = 'auto' | 'architect' | 'implementer' | 'reviewer';

/** All modes, in UI order. */
export const AGENT_MODES: readonly AgentMode[] = ['auto', 'architect', 'implementer', 'reviewer'];

/** Default mode when nothing is configured. */
export const DEFAULT_AGENT_MODE: AgentMode = 'auto';

/** Env var the extension stamps at sidecar spawn. */
export const AGENT_MODE_ENV = 'SUNDAY_AGENT_MODE';

/** Plan/decompose tools an architect may use when registered (none exist yet). */
export const ARCHITECT_PLANNING_TOOLS: ReadonlySet<string> = new Set(['plan', 'decompose']);

/** Reviewer-only tools beyond the read-only set (comment/diff helpers). */
export const REVIEWER_EXTRA_TOOLS: ReadonlySet<string> = new Set([
  // Reserved for future comment/diff tools; the read-only set already
  // covers git_diff + search + read_file which reviewers use today.
]);

/** Parse a mode string; unknown/empty values fall back to `auto`. */
export function parseAgentMode(value: string | undefined | null): AgentMode {
  const v = (value ?? '').trim().toLowerCase();
  return (AGENT_MODES as readonly string[]).includes(v) ? (v as AgentMode) : DEFAULT_AGENT_MODE;
}

/**
 * Tool allowlist for a mode, or null when the mode allows every tool.
 * Unknown tool names are denied in restricted modes (fail-closed).
 */
export function modeToolAllowlist(mode: AgentMode): ReadonlySet<string> | null {
  switch (mode) {
    case 'auto':
    case 'implementer':
      return null;
    case 'architect':
      return new Set([...READ_ONLY_TOOLS, ...ARCHITECT_PLANNING_TOOLS]);
    case 'reviewer':
      return new Set([...READ_ONLY_TOOLS, ...REVIEWER_EXTRA_TOOLS]);
  }
}

/** Whether `toolName` may run under `mode`. */
export function canUseTool(mode: AgentMode, toolName: string): boolean {
  const allowlist = modeToolAllowlist(mode);
  return allowlist === null || allowlist.has(toolName);
}

/**
 * Denial message fed back to the model when a mode blocks a tool call.
 * Reviewer mode uses the exact contract string "Reviewer mode: writes
 * disabled" for write tools.
 */
export function modeDenialMessage(mode: AgentMode, toolName: string): string {
  if (mode === 'reviewer' && WRITE_TOOLS.has(toolName)) {
    return `Reviewer mode: writes disabled — tool '${toolName}' is not available. ` +
      `Summarize your findings instead, or switch to Implementer mode to make changes.`;
  }
  if (mode === 'reviewer') {
    return `Reviewer mode: tool '${toolName}' is not available. ` +
      `Reviewers may only read code and diffs — describe what should change instead.`;
  }
  if (mode === 'architect') {
    return `Architect mode: tool '${toolName}' is not available. ` +
      `Architects plan with read-only tools; switch to Implementer mode to write or execute.`;
  }
  return `tool '${toolName}' is not available in ${mode} mode`;
}

/** System-prompt suffix describing the mode's working agreement. */
export function modeSystemPromptSuffix(mode: AgentMode): string {
  switch (mode) {
    case 'architect':
      return [
        '## Agent mode: Architect',
        '',
        'You are in Architect mode: produce plans, designs, and analysis. ',
        'You can read code, search, and inspect git history, but you cannot ',
        'write files or run commands. When the user asks for changes, respond ',
        'with a concrete step-by-step plan instead of executing it.',
      ].join('\n');
    case 'implementer':
      return [
        '## Agent mode: Implementer',
        '',
        'You are in Implementer mode: you have full tool access. Make the ',
        'requested changes directly with your tools.',
      ].join('\n');
    case 'reviewer':
      return [
        '## Agent mode: Reviewer',
        '',
        'You are in Reviewer mode: review code and describe findings. Writes ',
        'are disabled — never attempt write_file, edit_file, or run_terminal. ',
        'Summarize issues and propose concrete fixes in text.',
      ].join('\n');
    case 'auto':
      return '';
  }
}

/** Short display label for the status bar / quickpick. */
export function agentModeLabel(mode: AgentMode): string {
  switch (mode) {
    case 'auto': return 'Auto';
    case 'architect': return 'Architect';
    case 'implementer': return 'Implementer';
    case 'reviewer': return 'Reviewer';
  }
}
