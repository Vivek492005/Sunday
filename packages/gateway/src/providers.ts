import { streamChatCompletion } from './openai-compatible.js';
import type { ChatChunk, ChatProvider, ChatRequest, ModelEntry } from './types.js';

/** OpenRouter + Groq adapters. Both are OpenAI-compatible; the shared core in
 *  openai-compatible.ts does the HTTP + SSE work. API keys come from the
 *  environment (OPENROUTER_API_KEY / GROQ_API_KEY) — never from the repo. */

abstract class OpenAICompatibleProvider implements ChatProvider {
  abstract readonly id: string;
  abstract readonly label: string;

  protected abstract baseUrl(): string;
  protected abstract envVar(): string;
  protected defaultHeaders(): Record<string, string> {
    return {};
  }
  abstract listModels(): Promise<ModelEntry[]>;

  protected requireApiKey(): string {
    const key = process.env[this.envVar()]?.trim();
    if (!key) throw new Error(`missing API key: set ${this.envVar()} in the environment`);
    return key;
  }

  /** Strip a "provider:" prefix if present (the router usually does this). */
  protected resolveModel(ref: string): string {
    const i = ref.indexOf(':');
    return i > 0 ? ref.slice(i + 1) : ref;
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const apiKey = this.requireApiKey();
    yield* streamChatCompletion(
      { baseUrl: this.baseUrl(), apiKey, defaultHeaders: this.defaultHeaders() },
      {
        model: this.resolveModel(request.model),
        messages: request.messages,
        tools: request.tools,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
      },
    );
  }
}

// Defaults are a starting point; override via Sunday settings. Free-tier
// availability changes over time — the router surfaces provider 4xx/429
// visibly (§10.6) instead of failing silently.
const DEFAULT_OPENROUTER_MODELS: ModelEntry[] = [
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B (OpenRouter)',
    contextWindow: 131072,
    supportsTools: true,
  },
  {
    id: 'qwen/qwen-2.5-coder-32b-instruct',
    label: 'Qwen 2.5 Coder 32B (OpenRouter)',
    contextWindow: 32768,
    supportsTools: true,
  },
];

const DEFAULT_GROQ_MODELS: ModelEntry[] = [
  {
    id: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B Versatile (Groq)',
    contextWindow: 131072,
    supportsTools: true,
  },
  {
    id: 'llama-3.1-8b-instant',
    label: 'Llama 3.1 8B Instant (Groq)',
    contextWindow: 131072,
    supportsTools: true,
  },
];

export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly id = 'openrouter';
  readonly label = 'OpenRouter';

  protected baseUrl(): string {
    return 'https://openrouter.ai/api/v1';
  }
  protected envVar(): string {
    return 'OPENROUTER_API_KEY';
  }
  protected defaultHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': 'https://github.com/Vivek492005/Sunday_VS_CODE',
      'X-Title': 'Sunday',
    };
  }
  async listModels(): Promise<ModelEntry[]> {
    return DEFAULT_OPENROUTER_MODELS;
  }
}

export class GroqProvider extends OpenAICompatibleProvider {
  readonly id = 'groq';
  readonly label = 'Groq';

  protected baseUrl(): string {
    return 'https://api.groq.com/openai/v1';
  }
  protected envVar(): string {
    return 'GROQ_API_KEY';
  }
  async listModels(): Promise<ModelEntry[]> {
    return DEFAULT_GROQ_MODELS;
  }
}
