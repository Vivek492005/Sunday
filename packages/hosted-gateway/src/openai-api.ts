/**
 * @sunday/hosted-gateway — OpenAI-compatible HTTP API surface.
 *
 * Exposes a minimal, safe subset: `GET /v1/models` and
 * `POST /v1/chat/completions` (streaming and non-streaming).
 *
 * SECURITY: this is a *text chat* API. Tool use is forbidden — requests
 * carrying `tools`, `tool_choice`, `functions`, or `function_call` are
 * rejected with 400, and any tool-call chunks the model emits anyway are
 * dropped (never executed; there is nothing to execute them with).
 */

import type { ProviderMessage } from '@sunday/gateway';

export interface ValidatedChatRequest {
  model: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens: number;
  stream: boolean;
  /** Estimated input tokens, for rate limiting. */
  promptTokensEst: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ValidationLimits {
  maxBodyBytes: number;
  maxMessages: number;
  maxMessageChars: number;
  maxTokensCap: number;
  allowedModels: string[];
}

const CHAT_ROLES = new Set(['system', 'user', 'assistant']);

function extractText(content: unknown, maxChars: number): string {
  if (typeof content === 'string') {
    if (content.length > maxChars) {
      throw new ApiError(400, 'content_too_long', `message content exceeds ${maxChars} chars`);
    }
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text') {
        const t = (p as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      } else if (typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'image_url') {
        throw new ApiError(400, 'unsupported_content', 'image content is not supported by this gateway');
      }
      // Other part types are ignored (not rejected) — forward-compat.
    }
    const text = parts.join('');
    if (text.length > maxChars) {
      throw new ApiError(400, 'content_too_long', `message content exceeds ${maxChars} chars`);
    }
    return text;
  }
  throw new ApiError(400, 'invalid_content', 'message content must be a string or text-part array');
}

export function parseChatRequest(body: unknown, limits: ValidationLimits): ValidatedChatRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_request', 'request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;

  // --- Tool use is forbidden on the hosted gateway. ---
  for (const f of ['tools', 'tool_choice', 'functions', 'function_call']) {
    if (b[f] !== undefined) {
      throw new ApiError(
        400,
        'tools_not_supported',
        `'${f}' is not supported by the hosted gateway (text chat only)`,
      );
    }
  }

  const model = b['model'];
  if (typeof model !== 'string' || model.length === 0) {
    throw new ApiError(400, 'invalid_model', '`model` must be a non-empty string');
  }
  if (limits.allowedModels.length > 0 && !limits.allowedModels.includes(model)) {
    throw new ApiError(403, 'model_not_allowed', `model '${model}' is not enabled on this gateway`);
  }

  const rawMessages = b['messages'];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new ApiError(400, 'invalid_messages', '`messages` must be a non-empty array');
  }
  if (rawMessages.length > limits.maxMessages) {
    throw new ApiError(400, 'too_many_messages', `\`messages\` exceeds ${limits.maxMessages} entries`);
  }

  const messages: ProviderMessage[] = [];
  let promptChars = 0;
  for (const m of rawMessages) {
    if (typeof m !== 'object' || m === null) {
      throw new ApiError(400, 'invalid_message', 'each message must be an object');
    }
    const role = (m as Record<string, unknown>)['role'];
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new ApiError(400, 'invalid_role', '`role` must be system, user, or assistant');
    }
    const text = extractText((m as Record<string, unknown>)['content'], limits.maxMessageChars);
    promptChars += text.length;
    messages.push({ role, content: [{ type: 'text', text }] } as ProviderMessage);
  }

  let temperature: number | undefined;
  if (b['temperature'] !== undefined) {
    const t = b['temperature'];
    if (typeof t !== 'number' || !(t >= 0) || !(t <= 2)) {
      throw new ApiError(400, 'invalid_temperature', '`temperature` must be a number between 0 and 2');
    }
    temperature = t;
  }

  let maxTokens = limits.maxTokensCap;
  if (b['max_tokens'] !== undefined) {
    const mt = b['max_tokens'];
    if (typeof mt !== 'number' || !Number.isInteger(mt) || mt <= 0) {
      throw new ApiError(400, 'invalid_max_tokens', '`max_tokens` must be a positive integer');
    }
    // Clamp, don't reject — friendlier and still bounded.
    maxTokens = Math.min(mt, limits.maxTokensCap);
  }

  const stream = b['stream'] === true;

  return {
    model,
    messages,
    temperature,
    maxTokens,
    stream,
    promptTokensEst: Math.max(1, Math.ceil(promptChars / 4)),
  };
}

/** OpenAI-style error envelope. */
export function errorBody(err: unknown): { status: number; body: unknown } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: { error: { message: err.message, type: 'invalid_request_error', code: err.code } },
    };
  }
  const message = err instanceof Error ? err.message : 'internal server error';
  return {
    status: 500,
    body: {
      error: { message: 'internal server error', type: 'server_error', code: 'internal' },
      // Never leak internals to remote clients; keep detail server-side.
      ...(process.env.SUNDAY_HOSTED_DEBUG === '1' ? { detail: message } : {}),
    },
  };
}

let idCounter = 0;

/** Build a non-streaming OpenAI chat-completion response object. */
export function chatCompletionObject(opts: {
  model: string;
  text: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string;
}): unknown {
  idCounter += 1;
  return {
    id: `chatcmpl-${Date.now().toString(36)}-${idCounter}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: opts.text },
        finish_reason: opts.finishReason,
      },
    ],
    usage: {
      prompt_tokens: opts.promptTokens,
      completion_tokens: opts.completionTokens,
      total_tokens: opts.promptTokens + opts.completionTokens,
    },
  };
}

/** Build one SSE data line for a streaming delta. */
export function sseChunkObject(opts: {
  model: string;
  id: string;
  delta?: string;
  finishReason?: string | null;
}): string {
  const chunk: Record<string, unknown> = {
    id: opts.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        delta: opts.delta !== undefined ? { content: opts.delta } : {},
        finish_reason: opts.finishReason ?? null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Model list entry in OpenAI format. */
export function modelsListObject(models: Array<{ id: string }>): unknown {
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'sunday' })),
  };
}

export { CHAT_ROLES };
