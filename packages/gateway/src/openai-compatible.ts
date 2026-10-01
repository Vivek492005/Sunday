import type { ContentPart, ToolDefinition } from '@sunday/protocol';
import type { ChatChunk, ProviderMessage } from './types.js';

/** Shared core for OpenAI-compatible providers (OpenRouter, Groq): POST
 *  /chat/completions with SSE streaming, normalized into ChatChunks. */

export interface OpenAICompatibleConfig {
  baseUrl: string; // e.g. https://openrouter.ai/api/v1
  apiKey: string;
  defaultHeaders?: Record<string, string>;
  /** Send stream_options.include_usage (default true). Disable for providers
   *  that reject the field. */
  includeUsageOption?: boolean;
}

export class ProviderHttpError extends Error {
  /** Response headers, when available — the router reads `Retry-After` off
   *  these for the rate-limit scheduler. */
  readonly headers: Headers;
  constructor(
    readonly status: number,
    readonly bodyText: string,
    headers?: HeadersInit,
  ) {
    super(`provider HTTP ${status}: ${bodyText.slice(0, 300)}`);
    this.name = 'ProviderHttpError';
    this.headers = new Headers(headers);
  }
}

export async function* streamChatCompletion(
  config: OpenAICompatibleConfig,
  args: {
    model: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  },
): AsyncGenerator<ChatChunk> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        ...config.defaultHeaders,
      },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages.map(toOpenAIMessage),
        ...(args.tools?.length
          ? {
              tools: args.tools.map((t) => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
            }
          : {}),
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        ...(args.maxTokens !== undefined ? { max_tokens: args.maxTokens } : {}),
        stream: true,
        ...(config.includeUsageOption === false ? {} : { stream_options: { include_usage: true } }),
      }),
      signal: args.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      yield { type: 'done', finishReason: 'cancelled' };
      return;
    }
    throw err;
  }
  if (!res.ok || !res.body) {
    throw new ProviderHttpError(res.status, await safeBodyText(res), res.headers);
  }
  yield* parseSseStream(res.body);
}

/** Non-streaming FIM helpers for `FimProvider.complete` (Part B). Both throw
 *  ProviderHttpError on non-2xx and propagate AbortError unchanged. */

export interface FimHttpArgs {
  model: string;
  prefix: string;
  suffix?: string;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
}

function authHeaders(config: OpenAICompatibleConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    ...config.defaultHeaders,
  };
}

/** Native fill-in-the-middle: POST /completions with `prompt` + `suffix`.
 *  Only call this when the model is known to support it. */
export async function requestNativeFim(
  config: OpenAICompatibleConfig,
  args: FimHttpArgs,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/completions`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        model: args.model,
        prompt: args.prefix,
        ...(args.suffix !== undefined ? { suffix: args.suffix } : {}),
        max_tokens: args.maxTokens ?? 64,
        temperature: 0,
        ...(args.stop?.length ? { stop: args.stop } : {}),
      }),
      signal: args.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error(`FIM request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new ProviderHttpError(res.status, await safeBodyText(res), res.headers);
  }
  const json = (await res.json()) as { choices?: Array<{ text?: unknown }> };
  const text = json.choices?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

/** Fallback continuation: non-streaming POST /chat/completions with an
 *  instruction-free prompt — the raw prefix as the user message, temperature
 *  ~0, short maxTokens. The model continues the code; suffix is dropped. */
export async function requestChatContinuation(
  config: OpenAICompatibleConfig,
  args: FimHttpArgs,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        model: args.model,
        messages: [{ role: 'user', content: args.prefix }],
        temperature: 0,
        max_tokens: args.maxTokens ?? 64,
        ...(args.stop?.length ? { stop: args.stop } : {}),
        stream: false,
      }),
      signal: args.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error(`completion fallback request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new ProviderHttpError(res.status, await safeBodyText(res), res.headers);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

async function safeBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable body>';
  }
}

function partsToText(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/**
 * Map message parts to an OpenAI-compatible `content` value.
 *
 * All-text messages keep the legacy plain-string form (unchanged wire
 * behavior). If any image part is present, the message becomes the
 * array form: text parts → `{type:'text',text}` and image parts →
 * `{type:'image_url',image_url:{url: dataUrl}}`, per the chat-completions
 * vision format. Providers that reject mixed content will surface a
 * normal 4xx, which the router already handles.
 */
export function contentPartsToOpenAI(parts: ContentPart[]): string | Array<Record<string, unknown>> {
  if (!parts.some((p) => p.type === 'image')) return partsToText(parts);
  const out: Array<Record<string, unknown>> = [];
  for (const p of parts) {
    if (p.type === 'text') out.push({ type: 'text', text: p.text });
    else if (p.type === 'image') out.push({ type: 'image_url', image_url: { url: p.dataUrl } });
  }
  return out;
}

function toOpenAIMessage(m: ProviderMessage): Record<string, unknown> {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content };
    case 'user':
      return { role: 'user', content: contentPartsToOpenAI(m.content) };
    case 'assistant': {
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: partsToText(m.content) || null,
      };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      return msg;
    }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: partsToText(m.content) };
  }
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Incremental SSE parser: accumulates chunked tool-call arguments and tracks
 *  finish_reason across the stream. */
export class SseParser {
  private toolCalls = new Map<number, AccumulatedToolCall>();
  private finishReason: string | null = null;

  *feedPayload(json: unknown): Generator<ChatChunk> {
    if (typeof json !== 'object' || json === null) return;
    const choice = (json as { choices?: Array<{ delta?: any; finish_reason?: unknown }> }).choices?.[0];
    const delta = choice?.delta;
    if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
      yield { type: 'text-delta', delta: delta.content };
    }
    const toolCallDeltas = delta?.tool_calls;
    if (Array.isArray(toolCallDeltas)) {
      for (const tc of toolCallDeltas) {
        const index = typeof tc.index === 'number' ? tc.index : 0;
        const cur = this.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof tc.id === 'string' && tc.id) cur.id = tc.id;
        if (typeof tc.function?.name === 'string' && tc.function.name) cur.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') cur.arguments += tc.function.arguments;
        this.toolCalls.set(index, cur);
      }
    }
    if (typeof choice?.finish_reason === 'string') this.finishReason = choice.finish_reason;
    const usage = (json as { usage?: unknown }).usage;
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>;
      yield {
        type: 'usage',
        usage: { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens) },
      };
    }
  }

  *flush(): Generator<ChatChunk> {
    for (const tc of this.toolCalls.values()) {
      const { args, parseError } = parseArgs(tc.arguments);
      yield {
        type: 'tool-call',
        call: {
          id: tc.id || `tc_${Math.random().toString(36).slice(2)}`,
          name: tc.name,
          arguments: args,
          ...(parseError ? { argumentsParseError: parseError } : {}),
        },
      };
    }
    this.toolCalls.clear();
    yield { type: 'done', finishReason: mapFinishReason(this.finishReason) };
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function parseArgs(raw: string): { args: Record<string, unknown>; parseError?: string } {
  if (!raw.trim()) return { args: {} };
  try {
    const v: unknown = JSON.parse(raw);
    return { args: typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {} };
  } catch {
    return { args: {}, parseError: raw.slice(0, 500) };
  }
}

function mapFinishReason(r: string | null): 'stop' | 'tool_calls' | 'length' | 'cancelled' | 'error' {
  switch (r) {
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'error';
    default:
      return 'stop';
  }
}

/** Parse an SSE event stream (one `data:` JSON object per line, `[DONE]`
 *  terminator) into ChatChunks. */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatChunk> {
  const parser = new SseParser();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          yield* parser.flush();
          return;
        }
        if (!data) continue;
        try {
          yield* parser.feedPayload(JSON.parse(data));
        } catch {
          // Ignore malformed SSE data lines; the stream continues.
        }
      }
    }
    // Stream ended without [DONE] (e.g. abort): flush what we have.
    yield* parser.flush();
  } finally {
    reader.releaseLock();
  }
}
