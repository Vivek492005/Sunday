/**
 * @sunday/tools — tool mutability scopes.
 *
 * Which tools are read-only is a property of the tool catalogue itself, so
 * it lives here (not in the daemon's policy gate). Consumers that must never
 * mutate — the orchestrator (role=planner), the verifier, read-only policy
 * mode — scope themselves to exactly these names.
 */

/** Tools that never mutate state: safe to hand to read-only agents. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'search',
  'git_status',
  'git_diff',
  'git_log',
]);

/** Tools that mutate files or execute commands. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'run_terminal']);
