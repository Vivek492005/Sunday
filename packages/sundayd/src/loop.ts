import { randomUUID } from 'node:crypto';
import { ErrorCode, type ChatEvent, type ContentPart, type ToolCall } from '@sunday/protocol';
import { ProviderRegistry, Router, type RelayAttempt } from '@sunday/gateway';
import type { SandboxConfig, ToolRegistry } from '@sunday/tools';
import { canUseTool, modeDenialMessage, type AgentMode } from '@sunday/tools';
import { redactSecrets } from '@sunday/skills';
import { PolicyGate } from './policy.js';
import { wrapUntrustedToolOutput } from './untrusted.js';
import { markTainted, newTaintState, taintEscalationReason, type TaintState } from './taint.js';
import {
  firewallCheck,
  wrapUntrusted,
  sinkForTool,
  type UntrustedSource,
} from './injection-firewall.js';
import { credentialGateReason } from './credential-gate.js';
import type { StoredSession } from './sessions.js';
// F8 User Hooks: deterministic lifecycle hooks (block/modify/run/annotate).
// The manager is pure + testable; the loop fires events around tool dispatch.
import { HookManager, lifecycleEventsForTool, type HookContext, type HookDispatchResult } from './hooks.js';
import { isWorkspaceTrusted } from './trust.js';
import type { HookEvent } from '@sunday/hooks';
// F2 Loop Breaker: the guard itself is pure (no vscode) and lives in the
// sunday-agent package; sundayd's AgentLoop is the real tool-call loop, so
// the breaker is enforced here.
import {
  LoopGuard,
  type LoopGuardPolicy,
  type LoopGuardTrigger,
} from 'sunday-agent/dist/loopGuard/index.js';

export const DEFAULT_MODEL = 'sunday:meta-llama/llama-3.3-70b-instruct';
export const DEFAULT_MAX_ITERATIONS = 25;

export interface AgentLoopDeps {
  tools: ToolRegistry;
  providers: ProviderRegistry;
}

export interface AgentLoopOptions {
  router?: Router;
  policy?: PolicyGate;
  defaultModel?: string;
  maxIterations?: number;
  /**
   * Hardening: sandbox execution for agent shell commands. Stamped onto
   * every ToolContext in executeCall; `run_terminal` routes to the sandbox
   * when mode !== 'off'. Undefined = host execution (current behavior).
   */
  sandbox?: SandboxConfig;
  /**
   * Group B4: agent mode (auto/architect/implementer/reviewer). Restricted
   * modes deny tools outside their allowlist in executeCall with a
   * mode-specific message. Undefined = auto (no gating).
   */
  agentMode?: AgentMode;
  /**
   * F2 Loop Breaker: runaway-loop detection policy. When set (and not
   * explicitly disabled), every tool call is checked pre/post execution;
   * on trip the loop emits `loop-guard-paused` and stops the turn
   * (pause/escalate) or errors it (abort). Undefined = guard enabled with
   * defaults.
   */
  loopGuard?: Partial<LoopGuardPolicy>;
  /**
   * F6 Durable Sessions: optional sink for session-log events. Called with
   * (sessionId, entryType, payload) for tool calls/results so the daemon can
   * persist them to the event-sourced log. Undefined = no logging (tests,
   * fire-and-forget loops). Never throws — the loop must not depend on it.
   */
  onSessionEvent?: (
    sessionId: string,
    type: 'tool_call' | 'tool_result' | 'approval',
    payload: Record<string, unknown>,
  ) => void;
  /**
   * F8 User Hooks: deterministic lifecycle hooks. `enabled: false` disables
   * all hook execution. `workspaceRoot` defaults to the session cwd.
   * `trusted` defaults to `isWorkspaceTrusted(workspaceRoot)` — an
   * untrusted workspace runs ZERO hooks (fail closed). Undefined = hooks
   * enabled with defaults.
   */
  hooks?: {
    enabled?: boolean;
    workspaceRoot?: string;
    trusted?: boolean;
    homeDir?: string;
  };
}

export interface TurnEvents {
  /**
   * A chat event for the turn. `relay` is set (from the first relay on) on
   * every event after the router failed over to another provider — the sink
   * forwards it as `via: 'relay'` + `relay: {from,to,reason}` on the
   * `chat/event` notification so the Relay stays visible. Sinks that ignore
   * the parameter keep working unchanged.
   */
  event(sessionId: string, turnId: string, event: ChatEvent, relay?: RelayAttempt): void;
}

export interface RunTurnOptions {
  model?: string;
  signal?: AbortSignal;
  /** A2: per-turn sampling temperature (best-of-N variants). */
  temperature?: number;
}

interface PendingCall {
  call: ToolCall;
  /** Set when the model emitted non-JSON arguments. */
  parseError?: string;
}

/**
 * F10: map taint.ts source strings to firewall UntrustedSource values.
 * Unknown sources default to the most conservative bucket.
 */
function taintSourceForFirewall(sources: string[]): UntrustedSource {
  const KNOWN: ReadonlySet<string> = new Set([
    'web_fetch',
    'web_search',
    'mcp_tool_result',
    'file_read_untrusted',
    'browser_content',
    'readme',
    'issue_text',
    'chat_message_untrusted',
    'clipboard',
  ]);
  for (const s of sources) {
    if (KNOWN.has(s)) return s as UntrustedSource;
  }
  return 'mcp_tool_result';
}

/**
 * The agent loop (§9): stream a turn from the routed model, execute tool
 * calls through the policy gate + tool registry, feed results back until the
 * model stops calling tools. Every step is emitted as a `chat/event`
 * ChatEvent so the extension can render it live. Errors (including
 * cancellation) are terminal `turn-error` events — runTurn itself never throws.
 */
export class AgentLoop {
  private readonly router: Router;
  private readonly policy: PolicyGate;
  private readonly defaultModel: string;
  private readonly maxIterations: number;
  private readonly sandbox: SandboxConfig | undefined;
  private readonly agentMode: AgentMode | undefined;
  private readonly loopGuardPolicy: Partial<LoopGuardPolicy> | undefined;
  private readonly hooksOpts: AgentLoopOptions['hooks'];
  private readonly onSessionEvent: AgentLoopOptions['onSessionEvent'];

  constructor(
    private readonly deps: AgentLoopDeps,
    private readonly events: TurnEvents,
    opts: AgentLoopOptions = {},
  ) {
    this.router = opts.router ?? new Router(deps.providers);
    this.policy = opts.policy ?? new PolicyGate();
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.sandbox = opts.sandbox;
    this.agentMode = opts.agentMode;
    this.loopGuardPolicy = opts.loopGuard;
    this.onSessionEvent = opts.onSessionEvent;
    this.hooksOpts = opts.hooks;
  }

  /**
   * F8: build the per-turn HookManager. Disabled → null (zero overhead).
   * Trust defaults to the workspace verdict — fail closed.
   */
  private hookManagerFor(cwd: string): HookManager | null {
    if (this.hooksOpts?.enabled === false) return null;
    const workspaceRoot = this.hooksOpts?.workspaceRoot ?? cwd;
    const trusted = this.hooksOpts?.trusted ?? isWorkspaceTrusted(workspaceRoot);
    return new HookManager({ workspaceRoot, trusted, homeDir: this.hooksOpts?.homeDir });
  }

  /** F8: fire a lifecycle event; never throws (a hook bug can't break the loop). */
  private async fireHook(
    hooks: HookManager | null,
    event: HookEvent,
    ctx: Omit<HookContext, 'event'>,
  ): Promise<HookDispatchResult | null> {
    if (!hooks) return null;
    try {
      return await hooks.dispatch({ ...ctx, event });
    } catch {
      return { annotations: [], commandErrors: [], ran: [], commandsRan: [] };
    }
  }

  async runTurn(
    turnId: string,
    session: StoredSession,
    message: string | ContentPart[],
    opts: RunTurnOptions = {},
  ): Promise<void> {
    // Per-turn relay state: once the router fails over, every subsequent
    // event in this turn carries the relay metadata (never silent).
    let turnRelay: RelayAttempt | undefined;
    const emit = (event: ChatEvent) =>
      this.events.event(session.id, turnId, event, turnRelay);
    const content: ContentPart[] =
      typeof message === 'string' ? [{ type: 'text', text: message }] : message;
    session.messages.push({ role: 'user', content });

    const modelRef = opts.model ?? session.model ?? this.defaultModel;
    const cwd = session.cwd ?? process.cwd();
    // F8 User Hooks: per-turn manager (trust-checked, consent-checked).
    const hooks = this.hookManagerFor(cwd);
    const hookBase = { cwd, workspaceRoot: hooks?.workspaceRoot ?? cwd, sessionId: session.id, turnId };
    // F8: session.start — annotations feed the opening context.
    const startHooks = await this.fireHook(hooks, 'session.start', { ...hookBase });
    if (startHooks?.annotations.length) {
      session.messages.push({
        role: 'user',
        content: [{ type: 'text', text: `[hooks:session.start]\n${startHooks.annotations.join('\n')}` }],
      });
    }
    // S5: per-turn taint state — untrusted content (file reads, web, MCP)
    // escalates state-changing tool calls to manual approval.
    const taint = newTaintState();
    // F2 Loop Breaker: one guard per turn; re-armed at turn start.
    const guard =
      this.loopGuardPolicy?.enabled === false ? undefined : new LoopGuard(this.loopGuardPolicy);
    guard?.reset();
    // F2: per-turn token accounting feeds the spend-divergence detector.
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let accountedInputTokens = 0;
    let accountedOutputTokens = 0;

    try {
      for (let i = 0; i < this.maxIterations; i++) {
        throwIfAborted(opts.signal);
        const routed = await this.router.chat({
          model: modelRef,
          messages: session.messages,
          tools: this.deps.tools.definitions(),
          signal: opts.signal,
          // A2: undefined = provider default; best-of-N sets per attempt.
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        });
        if (routed.relay && !turnRelay) turnRelay = routed.relay;
        const stream = routed.stream;

        let text = '';
        const calls: PendingCall[] = [];
        for await (const chunk of stream) {
          throwIfAborted(opts.signal);
          if (chunk.type === 'text-delta') {
            text += chunk.delta;
            emit({ type: 'text-delta', delta: chunk.delta });
          } else if (chunk.type === 'tool-call') {
            const call: ToolCall = {
              id: chunk.call.id,
              name: chunk.call.name,
              arguments: chunk.call.arguments,
            };
            calls.push({ call, parseError: chunk.call.argumentsParseError });
            emit({ type: 'tool-call', call });
          } else if (chunk.type === 'usage') {
            turnInputTokens += chunk.usage.inputTokens;
            turnOutputTokens += chunk.usage.outputTokens;
            emit({ type: 'usage', usage: chunk.usage });
          }
          // 'done' needs no action — the loop below decides what happens next.
        }

        if (calls.length === 0) {
          if (text) session.messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
          // F8: task.end — e.g. test-before-done. A block is fed back as a
          // user message so the model sees it next turn; annotations too.
          const endHooks = await this.fireHook(hooks, 'task.end', { ...hookBase });
          const endNotes: string[] = [];
          if (endHooks?.blocked) {
            endNotes.push(
              `[hooks:task.end] BLOCKED by "${endHooks.blocked.hookName}": ${endHooks.blocked.reason}`,
            );
          }
          if (endHooks?.annotations.length) {
            endNotes.push(`[hooks:task.end]\n${endHooks.annotations.join('\n')}`);
          }
          if (endNotes.length) {
            session.messages.push({
              role: 'user',
              content: [{ type: 'text', text: endNotes.join('\n') }],
            });
          }
          emit({ type: 'turn-end', finishReason: 'stop' });
          return;
        }

        session.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text }],
          toolCalls: calls.map((c) => c.call),
        });

        for (const { call, parseError } of calls) {
          throwIfAborted(opts.signal);
          // F6: record the tool call in the session event log (best-effort).
          try {
            this.onSessionEvent?.(session.id, 'tool_call', {
              callId: call.id,
              name: call.name,
              args: call.arguments,
            });
          } catch {
            // logging must never break the turn
          }
          // F2 Loop Breaker: pre-execution check (repeated args, ping-pong).
          const pre = guard?.preCall(call.name, call.arguments);
          let tripped: LoopGuardTrigger | undefined = pre?.trigger;
          if (!tripped) {
            const result = await this.executeCall(call, parseError, cwd, opts.signal, taint, {
              hooks,
              hookBase,
            });
            emit({ type: 'tool-result', result });
            session.messages.push({ role: 'tool', toolCallId: call.id, content: result.content });
            // F6: record the tool result in the session event log.
            try {
              this.onSessionEvent?.(session.id, 'tool_result', {
                callId: call.id,
                name: call.name,
                ok: !result.isError,
                summary: contentText(result.content).slice(0, 2000),
              });
            } catch {
              // logging must never break the turn
            }
            // F2: post-execution check (repeated failures, spend divergence).
            // Attribute this call the token delta since the previous call.
            const callInput = Math.max(0, turnInputTokens - accountedInputTokens);
            const callOutput = Math.max(0, turnOutputTokens - accountedOutputTokens);
            accountedInputTokens = turnInputTokens;
            accountedOutputTokens = turnOutputTokens;
            tripped =
              pre && guard
                ? guard.postResult(pre.token, {
                    tool: call.name,
                    isError: result.isError,
                    resultText: contentText(result.content),
                    inputTokens: callInput,
                    outputTokens: callOutput,
                  })
                : undefined;
          }
          if (tripped && guard) {
            emit({
              type: 'loop-guard-paused',
              kind: tripped.kind,
              count: tripped.count,
              message: tripped.message,
              action: guard.policy.action,
              suggestedActions: tripped.suggestedActions,
            });
            if (guard.policy.action === 'abort') {
              emit({ type: 'turn-error', code: ErrorCode.TurnCancelled, message: tripped.message });
            } else {
              // pause: the agent stops and the UI offers change-strategy /
              // stronger-model / ask-user. escalate: F3 will attach the
              // single stronger-model retry (currently also pauses).
              emit({ type: 'turn-end', finishReason: 'stop' });
            }
            return;
          }
        }
        // Loop: the model sees the tool results on the next iteration.
      }
      // F8: task.end on max-steps as well (best-effort, never fatal).
      const maxEndHooks = await this.fireHook(hooks, 'task.end', { ...hookBase });
      if (maxEndHooks?.annotations.length) {
        session.messages.push({
          role: 'user',
          content: [{ type: 'text', text: `[hooks:task.end]\n${maxEndHooks.annotations.join('\n')}` }],
        });
      }
      emit({ type: 'turn-end', finishReason: 'max-steps' });
    } catch (e) {
      if (isAbort(e, opts.signal)) {
        emit({ type: 'turn-error', code: ErrorCode.TurnCancelled, message: 'turn cancelled' });
      } else {
        emit({
          type: 'turn-error',
          code: ErrorCode.InternalError,
          message: (e as Error)?.message ?? 'turn failed',
        });
      }
    }
  }

  private async executeCall(
    call: ToolCall,
    parseError: string | undefined,
    cwd: string,
    signal: AbortSignal | undefined,
    taint: TaintState,
    hookCtx?: { hooks: HookManager | null; hookBase: Omit<HookContext, 'event'> },
  ): Promise<{ toolCallId: string; content: ContentPart[]; isError: boolean }> {
    // F8 User Hooks: pre_tool (+ pre_edit/pre_commit) run before anything
    // else. Args are deep-cloned so modify_input actions can't corrupt the
    // original call; a block returns WITHOUT executing the tool (zero
    // executions — the acceptance gate). Annotations are collected and
    // appended to the tool result for the model.
    const mutableArgs: Record<string, unknown> = structuredClone(call.arguments ?? {});
    const hookAnnotations: string[] = [];
    if (hookCtx?.hooks) {
      const preCtx = { ...hookCtx.hookBase, toolName: call.name, args: mutableArgs };
      const preEvents: HookEvent[] = [
        'pre_tool',
        ...lifecycleEventsForTool(call.name).filter((e) => e.startsWith('pre_')),
      ];
      for (const event of preEvents) {
        const pre = await this.fireHook(hookCtx.hooks, event, preCtx);
        if (!pre) continue;
        if (pre.blocked) {
          return {
            toolCallId: call.id,
            content: [
              {
                type: 'text',
                text: `Hook blocked tool call '${call.name}' ("${pre.blocked.hookName}"): ${pre.blocked.reason}`,
              },
            ],
            isError: true,
          };
        }
        if (pre.annotations.length) hookAnnotations.push(...pre.annotations);
        // F8 (spec §4): hook run_command output is untrusted — taint the
        // turn so later state-changing calls escalate to manual approval.
        if (pre.commandsRan.length > 0) {
          markTainted(taint, 'hook_output');
        }
      }
    }
    if (parseError) {
      return {
        toolCallId: call.id,
        content: [{ type: 'text', text: `arguments parse error: ${parseError} — retry the call with valid JSON arguments` }],
        isError: true,
      };
    }
    // F7 Permission Intelligence: arg-aware policy decision (risk tiers,
    // profiles, scoped allowlists, batch plans). Falls back to the legacy
    // tool-name-only evaluate() when no intel is attached.
    const decision = this.policy.evaluateCall(
      call.name,
      mutableArgs,
      cwd,
    );
    if (!decision.allow) {
      return {
        toolCallId: call.id,
        content: [{ type: 'text', text: `Policy denied tool call '${call.name}': ${decision.reason}` }],
        isError: true,
      };
    }
    // Group B4: agent-mode gating — restricted modes (architect/reviewer)
    // deny tools outside their allowlist with a mode-specific message,
    // before any other dispatch. The denial is fed back to the model as a
    // tool error so it can adapt.
    if (this.agentMode !== undefined && !canUseTool(this.agentMode, call.name)) {
      return {
        toolCallId: call.id,
        content: [{ type: 'text', text: modeDenialMessage(this.agentMode, call.name) }],
        isError: true,
      };
    }
    // S5: taint escalation — when untrusted content was ingested this turn,
    // state-changing tools need manual approval even if policy allowed them.
    const taintReason = taintEscalationReason(taint, call.name);
    if (taintReason) {
      return {
        toolCallId: call.id,
        content: [{ type: 'text', text: `Taint escalation: ${taintReason}` }],
        isError: true,
      };
    }
    // F10: injection firewall — generalizes taint.ts with pattern detection.
    // When the turn is tainted, scan the proposed tool call (name + args)
    // for injection markers and enforce the taint-to-sink policy: untrusted
    // content reaching terminal/network/write-outside-workspace is NEVER
    // silently executed. Blocked calls are denied; ask-worthy calls are
    // escalated to the user, fed back as a tool error so the model adapts.
    if (taint.taintedThisTurn) {
      const source = taintSourceForFirewall(taint.taintSources);
      const verdict = firewallCheck(
        wrapUntrusted(
          `${call.name} ${JSON.stringify(mutableArgs)}`,
          source,
          `agent-loop:${call.name}`
        ),
        sinkForTool(call.name)
      );
      if (verdict.decision !== 'allow') {
        const verb = verdict.decision === 'block' ? 'Blocked' : 'Escalated for approval';
        return {
          toolCallId: call.id,
          content: [
            {
              type: 'text',
              text:
                `F10 injection firewall ${verb}: '${call.name}' with tainted ` +
                `context (sources: ${taint.taintSources.join(', ')}). ` +
                verdict.reasons.join(' '),
            },
          ],
          isError: true,
        };
      }
    }
    // S5: credential gate — reading .env/*.pem/id_rsa etc. requires manual
    // approval (SEC-10). The gate runs here (not in the tool) because the
    // policy decision belongs to the loop, not the filesystem tool.
    if (call.name === 'read_file' && !parseError) {
      const readPath = (mutableArgs as { path?: unknown } | null)?.path;
      if (typeof readPath === 'string') {
        const gateReason = credentialGateReason(readPath);
        if (gateReason) {
          return {
            toolCallId: call.id,
            content: [{ type: 'text', text: gateReason }],
            isError: true,
          };
        }
      }
    }
    // F8: dispatch with the (possibly hook-modified) args.
    const r = await this.deps.tools.call(call.name, mutableArgs, {
      cwd,
      signal,
      // Hardening: sandbox config rides on the context; run_terminal is the
      // only tool that reads it (single decision point in terminal.ts).
      sandbox: this.sandbox,
    });
    // F8: post_tool (+ post_edit) — annotations appended to the result so
    // the model sees them; a post block can't un-execute, so it's surfaced
    // as an error note (pre_* is the enforcement point).
    let postNote = '';
    if (hookCtx?.hooks) {
      const postCtx = { ...hookCtx.hookBase, toolName: call.name, args: mutableArgs };
      const postEvents: HookEvent[] = [
        'post_tool',
        ...lifecycleEventsForTool(call.name).filter((e) => e.startsWith('post_')),
      ];
      for (const event of postEvents) {
        const post = await this.fireHook(hookCtx.hooks, event, postCtx);
        if (!post) continue;
        if (post.annotations.length) hookAnnotations.push(...post.annotations);
        if (post.blocked) {
          postNote += `\n[hooks:${event}] "${post.blocked.hookName}" flagged after execution: ${post.blocked.reason}`;
        }
        if (post.commandsRan.length > 0) markTainted(taint, 'hook_output');
      }
    }
    // S5: file reads ingest untrusted content (the agent didn't write these
    // files) — mark the turn tainted so later state-changing calls escalate.
    if (call.name === 'read_file') markTainted(taint, 'file_read_untrusted');
    // §15.4: tool output is untrusted data — redact secret shapes before it
    // can reach the provider, and wrap it in explicit delimiters so the
    // model cannot mistake it for instructions.
    const safeOutput = wrapUntrustedToolOutput(call.name, redactSecrets(r.output));
    const content: ContentPart[] = [{ type: 'text', text: safeOutput }];
    if (hookAnnotations.length) {
      content.push({ type: 'text', text: `[hooks]\n${hookAnnotations.join('\n')}${postNote}` });
    } else if (postNote) {
      content.push({ type: 'text', text: `[hooks]${postNote}` });
    }
    return {
      toolCallId: call.id,
      content,
      isError: r.isError ?? false,
    };
  }
}

export function newTurnId(): string {
  return randomUUID();
}

/**
 * F2 Loop Breaker: read the guard policy from the environment (the sidecar
 * has no access to VS Code settings; the extension forwards
 * `sunday.loopGuard.*` here in a later pass). Defaults come from
 * DEFAULT_LOOP_GUARD_POLICY.
 */
export function loopGuardPolicyFromEnv(): Partial<LoopGuardPolicy> {
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const policy: Partial<LoopGuardPolicy> = {};
  if (process.env.SUNDAY_LOOPGUARD_ENABLED === '0' || process.env.SUNDAY_LOOPGUARD_ENABLED === 'false') {
    policy.enabled = false;
  }
  const threshold = num(process.env.SUNDAY_LOOPGUARD_THRESHOLD);
  if (threshold !== undefined) policy.threshold = Math.max(2, Math.floor(threshold));
  const action = process.env.SUNDAY_LOOPGUARD_ACTION;
  if (action === 'pause' || action === 'escalate' || action === 'abort') policy.action = action;
  const windowSize = num(process.env.SUNDAY_LOOPGUARD_WINDOW);
  if (windowSize !== undefined) policy.windowSize = Math.max(4, Math.floor(windowSize));
  return policy;
}

/** Flatten tool-result content parts to plain text for error signatures. */
function contentText(content: ContentPart[]): string {
  return content
    .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
    .join('\n');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('turn cancelled', 'AbortError');
}

function isAbort(e: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (e as Error)?.name === 'AbortError';
}
