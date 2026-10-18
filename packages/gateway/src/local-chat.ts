/**
 * F14 — Local-first Chat Mode (Ollama).
 *
 * Optional, opt-in local chat: Ask + Inline edit + Explain run on the user's
 * own Ollama server first, with graceful cloud fallback. The full agent loop
 * is only allowed on the local model after it passes a capability probe
 * (tool-call format, JSON adherence, edit apply) — small models are
 * unreliable agents, and we refuse to pretend otherwise.
 *
 * Privacy: `ChatRequest.privacy = 'local-only'` pins routing to the ollama
 * provider. The router throws LocalOnlyUnavailableError instead of ever
 * touching a cloud provider for such requests.
 *
 * This module is pure dependency-light logic: the probe takes an injected
 * chat function, so tests never need a real Ollama server.
 */
import type { ToolDefinition } from '@sunday/protocol';
import type { OllamaProvider } from './providers.js';
import type {
  ChatChunk,
  ProviderMessage,
} from './types.js';

/** Task classes that prefer the local model first (F3 router policies). */
export const LOCAL_CHAT_TASK_CLASSES = ['ask', 'explain', 'inline-edit'] as const;

export type LocalChatTaskClass = (typeof LOCAL_CHAT_TASK_CLASSES)[number];

/** Privacy tier for a request. 'local-only' NEVER leaves the machine. */
export type PrivacyTier = 'local-only' | 'any';

/**
 * Thrown when a `privacy: 'local-only'` request cannot be served locally.
 * The router raises this instead of falling back to any cloud provider —
 * silent cloud fallback would defeat the privacy guarantee.
 */
export class LocalOnlyUnavailableError extends Error {
  readonly code = 'LOCAL_ONLY_UNAVAILABLE';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LocalOnlyUnavailableError';
  }
}

export interface LocalChatConfig {
  /** Master switch. Env default: SUNDAY_LOCAL_CHAT=1. Off unless opted in. */
  enabled: boolean;
  /** "ollama:<model>" ref used for local-first chat modes. */
  model: string;
  /**
   * Capability probe outcome. null = not probed yet. The full agent loop
   * requires true (see isAgentLoopAllowed).
   */
  agentCapable: boolean | null;
  probedAt?: string;
}

const DEFAULT_LOCAL_MODEL = 'ollama:qwen2.5-coder:1.5b';

let config: LocalChatConfig = {
  enabled: /^(1|true|yes)$/i.test(process.env.SUNDAY_LOCAL_CHAT ?? ''),
  model: process.env.SUNDAY_LOCAL_MODEL?.trim() || DEFAULT_LOCAL_MODEL,
  agentCapable: null,
};

export function getLocalChatConfig(): LocalChatConfig {
  return { ...config };
}

export function setLocalChatConfig(patch: Partial<LocalChatConfig>): LocalChatConfig {
  config = { ...config, ...patch };
  return getLocalChatConfig();
}

/** Reset to env-derived defaults (tests). */
export function resetLocalChatConfig(): LocalChatConfig {
  config = {
    enabled: /^(1|true|yes)$/i.test(process.env.SUNDAY_LOCAL_CHAT ?? ''),
    model: process.env.SUNDAY_LOCAL_MODEL?.trim() || DEFAULT_LOCAL_MODEL,
    agentCapable: null,
  };
  return getLocalChatConfig();
}

export function isLocalChatEnabled(): boolean {
  return config.enabled;
}

/**
 * Full agent loop on the local model is only allowed after the model
 * passes the capability probe. Ask / Explain / Inline-edit (single-shot
 * chat) are fine without it — they degrade to visible text, not silent
 * tool-loop failures.
 */
export function isAgentLoopAllowed(): boolean {
  return config.enabled && config.agentCapable === true;
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

export interface ProbeCheck {
  pass: boolean;
  detail: string;
}

export interface CapabilityProbeResult {
  model: string;
  /** True only when ALL three checks pass. */
  agentCapable: boolean;
  checks: {
    toolCall: ProbeCheck;
    json: ProbeCheck;
    editApply: ProbeCheck;
  };
  probedAt: string;
}

/** Minimal chat surface the probe needs — implemented by OllamaProvider. */
export interface ProbeChat {
  (args: {
    model: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<ChatChunk>;
}

export interface ProbeOptions {
  /** Per-check timeout in ms. Default 30_000. */
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

interface Collected {
  text: string;
  toolCalls: Array<{ name: string; args: unknown; parseError?: string }>;
}

async function collect(
  stream: AsyncIterable<ChatChunk>,
  signal: AbortSignal,
): Promise<Collected> {
  const out: Collected = { text: '', toolCalls: [] };
  for await (const chunk of stream) {
    if (signal.aborted) break;
    if (chunk.type === 'text-delta') out.text += chunk.delta;
    else if (chunk.type === 'tool-call') {
      let args: unknown = null;
      let parseError: string | undefined;
      try {
        args = chunk.call.arguments;
      } catch (e) {
        parseError = (e as Error).message;
      }
      out.toolCalls.push({
        name: chunk.call.name,
        args,
        parseError: parseError ?? chunk.call.argumentsParseError,
      });
    }
  }
  return out;
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

const GET_WEATHER_TOOL: ToolDefinition = {
  name: 'get_weather',
  description: 'Look up the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
} as ToolDefinition;

function checkToolCall(c: Collected): ProbeCheck {
  const call = c.toolCalls.find((t) => t.name === 'get_weather');
  if (!call) {
    return {
      pass: false,
      detail: `no get_weather tool call emitted (got ${c.toolCalls.length} tool call(s), ${c.text.length} text chars)`,
    };
  }
  if (call.parseError) {
    return { pass: false, detail: `tool-call arguments failed to parse: ${call.parseError}` };
  }
  if (!call.args || typeof call.args !== 'object' || typeof (call.args as Record<string, unknown>).city !== 'string') {
    return {
      pass: false,
      detail: `tool-call arguments missing string 'city': ${JSON.stringify(call.args)?.slice(0, 120)}`,
    };
  }
  return { pass: true, detail: `valid get_weather call with city=${JSON.stringify((call.args as Record<string, unknown>).city)}` };
}

function checkJson(c: Collected): ProbeCheck {
  const text = c.text.trim();
  const tryParse = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let parsed: unknown = tryParse(text);
  if (parsed === undefined) {
    // Lenient: extract the largest {...} block (models love wrappers).
    const m = text.match(/\{[\s\S]*\}/);
    if (m) parsed = tryParse(m[0]);
  }
  if (
    parsed !== undefined &&
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as Record<string, unknown>).status === 'ok' &&
    (parsed as Record<string, unknown>).count === 3
  ) {
    return { pass: true, detail: 'model returned parseable JSON with expected fields' };
  }
  return {
    pass: false,
    detail: `response was not the expected JSON (first 120 chars: ${JSON.stringify(text.slice(0, 120))})`,
  };
}

function checkEditApply(c: Collected): ProbeCheck {
  // Accept `x + 1` / `x+1` inside or outside a fenced block.
  const ok = /x\s*\+\s*1/.test(c.text) && !/x\s*\+\s*2/.test(c.text.replace(/x\s*\+\s*1/g, ''));
  if (ok) {
    return { pass: true, detail: 'edit applied: function now adds 1' };
  }
  return {
    pass: false,
    detail: `expected rewritten function adding 1 (first 160 chars: ${JSON.stringify(c.text.slice(0, 160))})`,
  };
}

/**
 * Run the 3 mini-tasks against a local model and decide whether it can run
 * the full agent loop. Never throws for model misbehaviour — a failing
 * model yields `{ agentCapable: false }`, not an exception. Transport-level
 * errors (Ollama down mid-probe) propagate to the caller.
 */
export async function probeLocalCapability(
  chat: ProbeChat,
  model: string,
  opts: ProbeOptions = {},
): Promise<CapabilityProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probedAt = new Date().toISOString();

  const run = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const { signal, done } = withTimeout(timeoutMs);
    try {
      return await fn(signal);
    } finally {
      done();
    }
  };

  const toolCall = await run(async (signal) => {
    const out = await collect(
      chat({
        model,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Call get_weather with city set to Paris. Do not write anything else.' }],
          },
        ],
        tools: [GET_WEATHER_TOOL],
        maxTokens: 256,
        signal,
      }),
      signal,
    );
    return checkToolCall(out);
  });

  const json = await run(async (signal) => {
    const out = await collect(
      chat({
        model,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Reply with ONLY this JSON object, nothing else: {"status": "ok", "count": 3}' }],
          },
        ],
        maxTokens: 128,
        signal,
      }),
      signal,
    );
    return checkJson(out);
  });

  const editApply = await run(async (signal) => {
    const out = await collect(
      chat({
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Rewrite the following function so it adds 1 instead of 2. Reply with ONLY the rewritten code in a fenced code block, no explanation.\n\nfunction inc(x) { return x + 2; }',
              },
            ],
          },
        ],
        maxTokens: 256,
        signal,
      }),
      signal,
    );
    return checkEditApply(out);
  });

  const agentCapable = toolCall.pass && json.pass && editApply.pass;
  return { model, agentCapable, checks: { toolCall, json, editApply }, probedAt };
}

export interface OllamaProbeOptions extends ProbeOptions {
  /** Model ref; defaults to the configured local model. */
  model?: string;
}

/**
 * Convenience wrapper: probe the configured Ollama server. When Ollama is
 * not running, returns `{ agentCapable: false }` with explanatory details
 * instead of throwing — callers can degrade gracefully. Also records the
 * outcome into the module config (agentCapable + probedAt).
 */
export async function probeOllama(
  provider: OllamaProvider,
  opts: OllamaProbeOptions = {},
): Promise<CapabilityProbeResult> {
  const available = await provider.isAvailable();
  const model = opts.model ?? getLocalChatConfig().model;
  if (!available) {
    const probedAt = new Date().toISOString();
    const detail = 'ollama server not reachable — start it with `ollama serve`';
    const result: CapabilityProbeResult = {
      model,
      agentCapable: false,
      checks: {
        toolCall: { pass: false, detail },
        json: { pass: false, detail },
        editApply: { pass: false, detail },
      },
      probedAt,
    };
    setLocalChatConfig({ agentCapable: false, probedAt });
    return result;
  }
  const chat: ProbeChat = ({ model: m, messages, tools, maxTokens, signal }) =>
    provider.chat({
      model: m,
      messages,
      tools,
      maxTokens,
      signal,
    });
  const result = await probeLocalCapability(chat, model, opts);
  setLocalChatConfig({ agentCapable: result.agentCapable, probedAt: result.probedAt });
  return result;
}
