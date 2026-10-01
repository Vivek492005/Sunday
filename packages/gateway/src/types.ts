import type { ContentPart, ToolCall, ToolDefinition, Usage } from '@sunday/protocol';
import type { SchedulerPriority } from './multi-scheduler.js';

/** Gateway types (§10). The gateway speaks to hosted providers through
 *  OpenAI-compatible adapters and streams normalized chunks to sundayd. */

/** A message in provider space. Unlike protocol ChatMessage (user input over
 *  the wire), this includes system / tool roles needed for the agent loop. */
export type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: ContentPart[] }
  | { role: 'assistant'; content: ContentPart[]; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: ContentPart[] };

export interface ChatRequest {
  /** "provider:model" (e.g. "openrouter:meta-llama/llama-3.3-70b-instruct")
   *  or a bare model id — the router resolves it. */
  model: string;
  messages: ProviderMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Parallel-agents scheduling context. When set AND the Router was built
   * with a `MultiAgentScheduler`, this request's quota slot is fair-queued
   * through the scheduler (priority + round-robin across agents) instead of
   * the plain per-provider limiter. When unset, routing behaves exactly as
   * before — single-agent flows are untouched.
   */
  agent?: AgentRequestContext;
}

/**
 * Identifies which agent (run unit) a model request belongs to, for fair
 * quota scheduling across parallel agents.
 */
export interface AgentRequestContext {
  /** Agent / run-unit id (e.g. the orchestration unit id). */
  id: string;
  /** Priority class; defaults to P1 (agent step). */
  priority?: SchedulerPriority;
}

export type ChatChunk =
  | { type: 'text-delta'; delta: string }
  | {
      type: 'tool-call';
      call: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        /** Set when the model emitted non-JSON arguments; sundayd feeds this
         *  back to the model as a tool error so it can retry. */
        argumentsParseError?: string;
      };
    }
  | { type: 'usage'; usage: Usage }
  | {
      type: 'done';
      finishReason: 'stop' | 'tool_calls' | 'length' | 'cancelled' | 'error';
    };

export interface ModelEntry {
  id: string; // bare provider-side id, e.g. "llama-3.3-70b-versatile"
  label: string;
  contextWindow: number;
  supportsTools: boolean;
  /** Advertises a native fill-in-the-middle endpoint (e.g. /completions with
   *  `suffix`). Default false — providers without it use the chat fallback. */
  supportsFim: boolean;
}

export interface ChatProvider {
  readonly id: string; // 'openrouter' | 'groq'
  readonly label: string;
  chat(request: ChatRequest): AsyncIterable<ChatChunk>;
  listModels(): Promise<ModelEntry[]>;
}

/** Fill-in-the-middle completion request (ghost text / autocomplete). */
export interface FimRequest {
  /** "provider:model" or bare model id — resolved like ChatRequest.model. */
  model: string;
  /** Code before the cursor. */
  prefix: string;
  /** Code after the cursor (dropped on providers without native FIM). */
  suffix?: string;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
}

export interface FimResult {
  /** Raw completion text for the cursor position (no prompt echo). */
  completion: string;
  /** True when served by the provider's native FIM endpoint. */
  nativeFim: boolean;
}

/** Optional capability on a ChatProvider: single-shot FIM completion.
 *  Implementations must never throw for "no FIM support" — they fall back
 *  to a prefix-only chat continuation instead. AbortError propagates. */
export interface FimProvider {
  complete(request: FimRequest): Promise<FimResult>;
}
