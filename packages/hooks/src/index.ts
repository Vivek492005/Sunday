/**
 * @sunday/hooks — F8 User Hooks & Policy-as-Code.
 *
 * Deterministic lifecycle hooks: `.sunday/hooks.json` (repo, untrusted —
 * needs workspace trust + hash-pinned consent) and `~/.sunday/hooks.json`
 * (user). Events: session.start, pre_tool, post_tool, pre_edit, post_edit,
 * pre_commit, task.end, compaction. Actions: block, modify_input,
 * run_command, annotate.
 */
export * from './schema.js';
export * from './matcher.js';
export * from './loader.js';
export * from './consent.js';
export * from './runner.js';
export * from './recipes.js';
