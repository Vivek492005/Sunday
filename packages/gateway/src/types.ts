import type { ContentPart, ToolCall, ToolDefinition, Usage } from '@sunday/protocol';

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
}

export interface ChatProvider {
  readonly id: string; // 'openrouter' | 'groq'
  readonly label: string;
  chat(request: ChatRequest): AsyncIterable<ChatChunk>;
  listModels(): Promise<ModelEntry[]>;
}
