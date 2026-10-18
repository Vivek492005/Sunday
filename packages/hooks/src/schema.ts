/**
 * @sunday/hooks — F8 User Hooks & Policy-as-Code: zod schemas for hooks.json.
 *
 * Two files:
 *   - `<workspace>/.sunday/hooks.json` (repo-level — arbitrary code, needs
 *     workspace trust + explicit first-run consent, hash-pinned)
 *   - `~/.sunday/hooks.json` (user-level — the user's own policy)
 */

import { z } from 'zod';

/** Lifecycle events a hook can attach to. */
export const HookEventSchema = z.enum([
  'session.start',
  'pre_tool',
  'post_tool',
  'pre_edit',
  'post_edit',
  'pre_commit',
  'task.end',
  'compaction',
]);
export type HookEvent = z.infer<typeof HookEventSchema>;

/** What a hook can do when it fires. */
export const BlockActionSchema = z.object({
  type: z.literal('block'),
  /** Reason shown to the agent (fed back as the tool-call result). */
  reason: z.string().min(1).max(2000),
});

export const ModifyInputActionSchema = z.object({
  type: z.literal('modify_input'),
  /**
   * Limited modification — only these operations are allowed:
   * - `append_arg`: append a string to a string argument key
   * - `set_arg`: set an argument key to a literal value
   * - `add_flag`: append a CLI-style flag to an `args` array argument
   */
  op: z.enum(['append_arg', 'set_arg', 'add_flag']),
  /** Argument key to modify (e.g. "command", "args"). */
  key: z.string().min(1).max(200),
  /** Value to set/append (string or string array for add_flag). */
  value: z.union([z.string().max(4000), z.array(z.string().max(500)).max(20)]),
});

export const RunCommandActionSchema = z.object({
  type: z.literal('run_command'),
  /** Command to run (no shell by default — argv style). */
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(2000)).max(30).default([]),
  /** Extra env vars (secrets are stripped by the runner). */
  env: z.record(z.string().max(5000)).optional(),
  /** Per-action timeout override (ms). Runner default applies otherwise. */
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  /** When true, a non-zero exit blocks the triggering tool/event. */
  blockOnFailure: z.boolean().optional(),
  /** Template vars available in args: {file}, {tool}, {cwd}. Default true. */
  allowTemplates: z.boolean().optional(),
});

export const AnnotateActionSchema = z.object({
  type: z.literal('annotate'),
  /** Note appended to the agent's context for this turn. */
  text: z.string().min(1).max(2000),
});

export const HookActionSchema = z.discriminatedUnion('type', [
  BlockActionSchema,
  ModifyInputActionSchema,
  RunCommandActionSchema,
  AnnotateActionSchema,
]);
export type HookAction = z.infer<typeof HookActionSchema>;

/** Which tool calls / paths a hook applies to. Empty = matches everything. */
export const HookMatcherSchema = z.object({
  /** Tool-name globs, e.g. ["read_file", "run_*"]. */
  tools: z.array(z.string().min(1).max(200)).max(50).default([]),
  /** Path globs matched against the call's primary path arg, e.g. ["**\/.env*"]. */
  paths: z.array(z.string().min(1).max(500)).max(50).default([]),
});
export type HookMatcher = z.infer<typeof HookMatcherSchema>;

export const HookDefSchema = z.object({
  /** Unique name within the file (used in logs + consent UI). */
  name: z.string().min(1).max(120),
  event: HookEventSchema,
  match: HookMatcherSchema.default({ tools: [], paths: [] }),
  actions: z.array(HookActionSchema).min(1).max(10),
  /** Per-hook timeout override (ms) for run_command actions. */
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  enabled: z.boolean().default(true),
});
export type HookDef = z.infer<typeof HookDefSchema>;

export const HooksFileSchema = z.object({
  version: z.literal(1),
  hooks: z.array(HookDefSchema).max(100),
});
export type HooksFile = z.infer<typeof HooksFileSchema>;

/** Parse + validate a hooks.json payload. Throws on invalid. */
export function parseHooksFile(raw: unknown): HooksFile {
  return HooksFileSchema.parse(raw);
}

/** Safe parse — returns null instead of throwing. */
export function tryParseHooksFile(raw: unknown): HooksFile | null {
  const r = HooksFileSchema.safeParse(raw);
  return r.success ? r.data : null;
}
