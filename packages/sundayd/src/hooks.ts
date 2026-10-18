/**
 * @sunday/sundayd — F8 User Hooks: HookManager.
 *
 * Loads `.sunday/hooks.json` (repo) + `~/.sunday/hooks.json` (user),
 * enforces the trust model, and dispatches lifecycle events around tool
 * execution in the agent loop.
 *
 * Trust model (fail closed):
 *  1. Untrusted workspace → ZERO hook execution (not even user-level).
 *  2. Repo hooks need explicit first-run consent for the exact file hash
 *     (hash-pinned; any byte change → re-consent). Pending-consent hooks
 *     are skipped and reported via `pendingConsent` for the UI.
 *  3. Hook `run_command` output is untrusted: the loop marks the turn
 *     tainted when a hook command produces output (see loop.ts).
 *
 * sundayd is headless and never prompts — consent is granted out-of-band
 * (extension UI) via `recordConsent()`. Hooks awaiting consent simply
 * don't run until then.
 */

import {
  hasConsented,
  hookMatches,
  loadHooks,
  runHookCommand,
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookAction,
  type HookDef,
  type HookEvent,
} from '@sunday/hooks';

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  /** Mutable copy of the tool args — modify_input actions mutate this. */
  args?: Record<string, unknown>;
  cwd: string;
  workspaceRoot: string;
  sessionId?: string;
  turnId?: string;
}

export interface HookDispatchResult {
  /** Set when a block action fired — the tool must NOT execute. */
  blocked?: { hookName: string; reason: string };
  /** Annotations to append to the agent's context. */
  annotations: string[];
  /** Hook command failures (for logging; never fatal). */
  commandErrors: string[];
  /** Names of hooks that ran. */
  ran: string[];
  /** Names of hooks whose run_command action executed (output = untrusted). */
  commandsRan: string[];
}

export interface HookManagerOptions {
  /** Workspace root for `.sunday/hooks.json` + trust lookup. */
  workspaceRoot: string;
  /** Trust verdict — injected for testability (defaults to isWorkspaceTrusted). */
  trusted?: boolean;
  /** Home dir for `~/.sunday/` files — injected for tests. */
  homeDir?: string;
}

/** Tools that count as "edits" for pre_edit/post_edit events. */
export const EDIT_TOOLS = new Set(['write_file', 'edit_file']);
/** Tools that count as "commits" for pre_commit. */
export const COMMIT_TOOLS = new Set(['git_commit']);

export class HookManager {
  private readonly hooks: (HookDef & { source: 'repo' | 'user' })[];
  private readonly pendingConsentHooks: (HookDef & { source: 'repo' | 'user' })[] = [];
  private readonly loadErrors: string[];
  private readonly trusted: boolean;
  readonly workspaceRoot: string;
  readonly repoHash: string | undefined;

  constructor(opts: HookManagerOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    // Fail closed: untrusted (or unknown) workspace → no hooks at all.
    this.trusted = opts.trusted ?? false;

    if (!this.trusted) {
      this.hooks = [];
      this.loadErrors = [];
      this.repoHash = undefined;
      return;
    }

    const { hooks, repoHash, errors } = loadHooks(opts.workspaceRoot, opts.homeDir);
    this.loadErrors = errors;
    this.repoHash = repoHash;

    // Repo hooks need hash-pinned consent; user hooks are the user's own.
    const live: typeof this.hooks = [];
    for (const h of hooks) {
      if (h.source === 'repo') {
        if (repoHash && hasConsented(repoHash, opts.homeDir)) {
          live.push(h);
        } else {
          this.pendingConsentHooks.push(h);
        }
      } else {
        live.push(h);
      }
    }
    this.hooks = live;
  }

  /** Non-fatal load/parse problems. */
  get errors(): string[] {
    return this.loadErrors;
  }

  /** Repo hooks skipped for lack of consent — surfaced to the UI. */
  get pendingConsent(): { name: string; event: HookEvent }[] {
    return this.pendingConsentHooks.map((h) => ({ name: h.name, event: h.event }));
  }

  /** Whether any hook is registered for the event. */
  hasHooksFor(event: HookEvent): boolean {
    return this.hooks.some((h) => h.event === event);
  }

  /**
   * Dispatch an event to matching hooks. Never throws — hook failures are
   * collected, never fatal. A block action short-circuits: later hooks for
   * the same event still run (annotations), but `blocked` is set and the
   * caller must NOT execute the tool.
   */
  async dispatch(ctx: HookContext): Promise<HookDispatchResult> {
    const result: HookDispatchResult = { annotations: [], commandErrors: [], ran: [], commandsRan: [] };
    if (!this.trusted) return result;

    for (const hook of this.hooks) {
      if (hook.event !== ctx.event) continue;
      if (ctx.toolName && !hookMatches(hook.match, ctx.toolName, ctx.args)) continue;
      if (!ctx.toolName && (hook.match.tools.length > 0 || hook.match.paths.length > 0)) continue;
      result.ran.push(hook.name);

      for (const action of hook.actions) {
        // A block ends the tool call but other hooks still get their say.
        if (result.blocked) {
          if (action.type === 'annotate') {
            result.annotations.push(`[${hook.name}] ${action.text}`);
          }
          continue;
        }
        await this.runAction(hook.name, action, ctx, hook.timeoutMs, result);
      }
    }
    return result;
  }

  private async runAction(
    hookName: string,
    action: HookAction,
    ctx: HookContext,
    hookTimeoutMs: number | undefined,
    result: HookDispatchResult,
  ): Promise<void> {
    switch (action.type) {
      case 'block':
        result.blocked = { hookName, reason: action.reason };
        break;
      case 'modify_input':
        applyModifyInput(ctx, action);
        break;
      case 'annotate':
        result.annotations.push(`[${hookName}] ${action.text}`);
        break;
      case 'run_command': {
        result.commandsRan.push(hookName);
        const templates = {
          file: primaryPath(ctx.args),
          tool: ctx.toolName,
          cwd: ctx.workspaceRoot,
        };
        const r = await runHookCommand(action.command, action.args, {
          cwd: ctx.workspaceRoot,
          timeoutMs: action.timeoutMs ?? hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
          env: action.env,
          templates,
          allowTemplates: action.allowTemplates,
        });
        if (r.timedOut) {
          // Timeout is NOT fatal — the agent loop must never hang.
          result.commandErrors.push(
            `[${hookName}] command timed out after ${action.timeoutMs ?? hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS}ms and was killed`,
          );
        } else if (r.spawnError) {
          result.commandErrors.push(`[${hookName}] spawn failed: ${r.spawnError}`);
        } else if (r.exitCode !== 0) {
          const msg = `[${hookName}] exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`;
          result.commandErrors.push(msg);
          if (action.blockOnFailure) {
            result.blocked = { hookName, reason: `Hook command failed: ${msg}` };
          }
        }
        break;
      }
    }
  }
}

/** Apply a limited modify_input action to the (mutable) hook context args. */
function applyModifyInput(
  ctx: HookContext,
  action: Extract<HookAction, { type: 'modify_input' }>,
): void {
  if (!ctx.args || typeof ctx.args !== 'object') return;
  const args = ctx.args;
  switch (action.op) {
    case 'set_arg':
      args[action.key] = action.value;
      break;
    case 'append_arg':
      if (typeof args[action.key] === 'string' && typeof action.value === 'string') {
        args[action.key] = (args[action.key] as string) + action.value;
      }
      break;
    case 'add_flag': {
      const flags = Array.isArray(action.value) ? action.value : [action.value];
      const cur = args[action.key];
      if (Array.isArray(cur)) {
        args[action.key] = [...(cur as unknown[]), ...flags];
      } else if (cur === undefined) {
        args[action.key] = [...flags];
      }
      break;
    }
  }
}

function primaryPath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['path', 'file', 'filePath', 'target']) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Map a tool name to the "edit/commit" lifecycle events it participates in.
 * Used by the loop to fire pre_edit/post_edit/pre_commit around the generic
 * pre_tool/post_tool events.
 */
export function lifecycleEventsForTool(toolName: string): HookEvent[] {
  if (EDIT_TOOLS.has(toolName)) return ['pre_edit', 'post_edit'];
  if (COMMIT_TOOLS.has(toolName)) return ['pre_commit'];
  return [];
}
