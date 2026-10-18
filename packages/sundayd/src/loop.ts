import { randomUUID } from 'node:crypto';
import { ErrorCode, type ChatEvent, type ContentPart, type ToolCall } from '@sunday/protocol';
import { ProviderRegistry, Router, type RelayAttempt } from '@sunday/gateway';
import type { SandboxConfig, ToolRegistry } from '@sunday/tools';
import { canUseTool, modeDenialMessage, type AgentMode } from '@sunday/tools';
import { redactSecrets } from '@sunday/skills';
import { PolicyGate } from './policy.js';
import { wrapUntrustedToolOutput } from './untrusted.js';
import { markTainted, newTaintState, taintEscalationReason, type TaintState } from './taint.js';
import { credentialGateReason } from './credential-gate.js';
import type { StoredSession } from './sessions.js';
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
          // F2 Loop Breaker: pre-execution check (repeated args, ping-pong).
          const pre = guard?.preCall(call.name, call.arguments);
          let tripped: LoopGuardTrigger | undefined = pre?.trigger;
          if (!tripped) {
            const result = await this.executeCall(call, parseError, cwd, opts.signal, taint);
            emit({ type: 'tool-result', result });
            session.messages.push({ role: 'tool', toolCallId: call.id, content: result.content });
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
  ): Promise<{ toolCallId: string; content: ContentPart[]; isError: boolean }> {
    if (parseError) {
      return {
        toolCallId: call.id,
        content: [{ type: 'text', text: `arguments parse error: ${parseError} — retry the call with valid JSON arguments` }],
        isError: true,
      };
    }
    const decision = this.policy.evaluate(call.name);
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
    // S5: credential gate — reading .env/*.pem/id_rsa etc. requires manual
    // approval (SEC-10). The gate runs here (not in the tool) because the
    // policy decision belongs to the loop, not the filesystem tool.
    if (call.name === 'read_file' && !parseError) {
      const readPath = (call.arguments as { path?: unknown } | null)?.path;
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
    const r = await this.deps.tools.call(call.name, call.arguments, {
      cwd,
      signal,
      // Hardening: sandbox config rides on the context; run_terminal is the
      // only tool that reads it (single decision point in terminal.ts).
      sandbox: this.sandbox,
    });
    // S5: file reads ingest untrusted content (the agent didn't write these
    // files) — mark the turn tainted so later state-changing calls escalate.
    if (call.name === 'read_file') markTainted(taint, 'file_read_untrusted');
    // §15.4: tool output is untrusted data — redact secret shapes before it
    // can reach the provider, and wrap it in explicit delimiters so the
    // model cannot mistake it for instructions.
    const safeOutput = wrapUntrustedToolOutput(call.name, redactSecrets(r.output));
    return {
      toolCallId: call.id,
      content: [{ type: 'text', text: safeOutput }],
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
