import { ProviderHttpError, requestChatContinuation, requestNativeFim, streamChatCompletion } from './openai-compatible.js';
import type {
  ChatChunk,
  ChatProvider,
  ChatRequest,
  FimProvider,
  FimRequest,
  FimResult,
  ModelEntry,
} from './types.js';

/** OpenRouter + Groq adapters. Both are OpenAI-compatible; the shared core in
 *  openai-compatible.ts does the HTTP + SSE work. API keys come from the
 *  environment (OPENROUTER_API_KEY / GROQ_API_KEY) — never from the repo. */

abstract class OpenAICompatibleProvider implements ChatProvider, FimProvider {
  abstract readonly id: string;
  abstract readonly label: string;

  protected abstract baseUrl(): string;
  protected abstract envVar(): string;
  protected defaultHeaders(): Record<string, string> {
    return {};
  }
  abstract listModels(): Promise<ModelEntry[]>;

  /**
   * Provider quirk: bare model ids known to serve a native FIM endpoint
   * (POST /completions with `suffix`). Return null when the provider has no
   * FIM endpoint at all (Groq) — every request falls back to chat.
   */
  protected nativeFimModels(): ReadonlySet<string> | null {
    return null;
  }

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

  /** Single-shot FIM completion. Tries the native infill endpoint when the
   *  model advertises FIM support; otherwise falls back to a prefix-only chat
   *  continuation (suffix dropped). Never throws for "no FIM support" —
   *  only for transport errors; AbortError propagates to the caller. */
  async complete(request: FimRequest): Promise<FimResult> {
    const apiKey = this.requireApiKey();
    const model = this.resolveModel(request.model);
    const config = { baseUrl: this.baseUrl(), apiKey, defaultHeaders: this.defaultHeaders() };
    const args = {
      model,
      prefix: request.prefix,
      suffix: request.suffix,
      maxTokens: request.maxTokens,
      stop: request.stop,
      signal: request.signal,
    };
    const fimModels = this.nativeFimModels();
    if (fimModels !== null && fimModels.has(model)) {
      try {
        const completion = await requestNativeFim(config, args);
        return { completion, nativeFim: true };
      } catch (err) {
        // Abort is the caller's decision — never paper over it with a retry.
        if ((err as Error).name === 'AbortError') throw err;
        // Native endpoint failed (e.g. model lost FIM support): fall through
        // to the chat continuation instead of failing the keystroke.
      }
    }
    const completion = await requestChatContinuation(config, args);
    return { completion, nativeFim: false };
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
    supportsFim: false,
  },
  {
    id: 'qwen/qwen-2.5-coder-32b-instruct',
    label: 'Qwen 2.5 Coder 32B (OpenRouter)',
    contextWindow: 32768,
    supportsTools: true,
    // Qwen2.5-Coder is a FIM-trained coder; OpenRouter serves it on the
    // legacy /completions endpoint with `suffix` support.
    supportsFim: true,
  },
];

const DEFAULT_GROQ_MODELS: ModelEntry[] = [
  {
    id: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B Versatile (Groq)',
    contextWindow: 131072,
    supportsTools: true,
    supportsFim: false,
  },
  {
    id: 'llama-3.1-8b-instant',
    label: 'Llama 3.1 8B Instant (Groq)',
    contextWindow: 131072,
    supportsTools: true,
    supportsFim: false,
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
  /** OpenRouter serves /completions for FIM-capable models; the set is
   *  derived from the entries that advertise supportsFim. */
  protected override nativeFimModels(): ReadonlySet<string> {
    return new Set(
      DEFAULT_OPENROUTER_MODELS.filter((m) => m.supportsFim).map((m) => m.id),
    );
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

/**
 * Local Model slice (autocomplete only): Ollama speaking its OpenAI-compatible
 * API. No API key is required — the server runs on the user's own machine.
 *
 * Note on URLs: `OLLAMA_BASE_URL` names the Ollama server root (default
 * `http://localhost:11434`); the OpenAI-compatible chat/completions endpoints
 * live under `/v1`, so the provider base used by the shared HTTP core is
 * `<root>/v1`. The health check hits the native Ollama API at `<root>/api/tags`.
 */
export const OLLAMA_DEFAULT_MODEL = 'ollama:qwen2.5-coder:1.5b';

const OLLAMA_MODELS: ModelEntry[] = [
  {
    id: 'qwen2.5-coder:1.5b',
    label: 'Qwen 2.5 Coder 1.5B (Ollama, local)',
    contextWindow: 32768,
    supportsTools: false,
    // FIM-trained coder; Ollama serves it on the /v1/completions endpoint
    // with `suffix` support.
    supportsFim: true,
  },
];

export class OllamaProvider extends OpenAICompatibleProvider {
  readonly id = 'ollama';
  readonly label = 'Ollama (local)';

  /** Ollama server root — NOT the OpenAI-compat root (see note above). */
  ollamaHost(): string {
    return process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434';
  }

  protected baseUrl(): string {
    return `${this.ollamaHost()}/v1`;
  }

  protected envVar(): string {
    // Unused: requireApiKey() is a no-op below. Kept to satisfy the base class.
    return 'OLLAMA_API_KEY';
  }

  /** No API key exists for a local daemon — never throw for a missing one. */
  protected override requireApiKey(): string {
    return '';
  }

  /** The default code model serves native FIM via Ollama's /v1/completions. */
  protected override nativeFimModels(): ReadonlySet<string> {
    return new Set(OLLAMA_MODELS.filter((m) => m.supportsFim).map((m) => m.id));
  }

  async listModels(): Promise<ModelEntry[]> {
    return OLLAMA_MODELS;
  }

  /**
   * Health check: GET <host>/api/tags with a 2s timeout. True only when the
   * local Ollama server answers — used to decide whether local-first
   * completion is worth attempting.
   */
  async isAvailable(): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    // A health check must never keep the process alive on its own.
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      const res = await fetch(`${this.ollamaHost()}/api/tags`, {
        signal: ctrl.signal,
      });
      return res.ok;
    } catch {
      // Not installed / not running / connection refused — never throws.
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Sunday hosted gateway — zero-config AI for Sunday IDE users.
 *
 * Users sign in with GitHub in the IDE; the IDE passes the GitHub OAuth
 * token as SUNDAY_API_TOKEN. No API keys to copy, no provider accounts.
 * The gateway enforces a per-user daily free-tier quota server-side.
 *
 * Env:
 *   SUNDAY_API_URL   — gateway base URL (default https://sunday-ide.onrender.com)
 *   SUNDAY_API_TOKEN — GitHub OAuth token from the IDE sign-in
 *
 * Power users can still set OPENROUTER_API_KEY / GROQ_API_KEY for
 * bring-your-own-key unlimited usage — the router prefers BYOK providers
 * when their keys are present (see registry ordering).
 */
export const SUNDAY_DEFAULT_API_URL = 'https://sunday-final-ide.onrender.com';

const SUNDAY_UNREACHABLE_MESSAGE =
  'Sunday AI is unreachable. Check your internet connection, or set SUNDAY_API_URL to a self-hosted gateway.';
const SUNDAY_SIGNIN_MESSAGE =
  "Sunday sign-in required: run the 'Sunday: Sign In' command (or set SUNDAY_API_TOKEN) to use the free AI tier.";
const SUNDAY_QUOTA_MESSAGE =
  'Daily free AI quota exhausted (200/day). Try again tomorrow or set OPENROUTER_API_KEY for unlimited BYOK.';

/**
 * Map raw transport/HTTP failures from the hosted gateway to actionable,
 * user-friendly messages. The original error is preserved as `cause`.
 * Cancellation (AbortError) always propagates untouched.
 */
function friendlySundayError(err: unknown): Error {
  if (err instanceof Error && err.name === 'AbortError') return err;
  if (err instanceof ProviderHttpError) {
    if (err.status === 401) return new Error(SUNDAY_SIGNIN_MESSAGE, { cause: err });
    if (err.status === 429) return new Error(SUNDAY_QUOTA_MESSAGE, { cause: err });
    return new Error(`Sunday AI request failed (HTTP ${err.status}). ${err.bodyText.slice(0, 200)}`, {
      cause: err,
    });
  }
  if (err instanceof Error && /SUNDAY_API_TOKEN/.test(err.message)) {
    // Missing token (requireApiKey) — same fix as a 401: sign in.
    return new Error(SUNDAY_SIGNIN_MESSAGE, { cause: err });
  }
  // fetch() rejected: DNS failure, connection refused/reset, TLS error,
  // timeout — the gateway is unreachable.
  return new Error(SUNDAY_UNREACHABLE_MESSAGE, { cause: err });
}

const SUNDAY_DEFAULT_MODELS: ModelEntry[] = [
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B (Sunday hosted)',
    contextWindow: 128_000,
    supportsTools: true,
    supportsFim: false,
  },
];

export class SundayHostedProvider extends OpenAICompatibleProvider {
  readonly id = 'sunday';
  readonly label = 'Sunday (hosted)';

  /** Gateway base URL — operator override via SUNDAY_API_URL. */
  apiUrl(): string {
    return (process.env.SUNDAY_API_URL?.trim() || SUNDAY_DEFAULT_API_URL).replace(/\/$/, '');
  }

  protected baseUrl(): string {
    return `${this.apiUrl()}/v1`;
  }

  protected envVar(): string {
    return 'SUNDAY_API_TOKEN';
  }

  protected defaultHeaders(): Record<string, string> {
    return { 'X-Title': 'Sunday' };
  }

  /** True when the user is signed in (token present) — no network call. */
  isConfigured(): boolean {
    return !!process.env[this.envVar()]?.trim();
  }

  /**
   * Chat via the hosted gateway. Network outages, missing sign-in, and
   * free-tier quota exhaustion surface as actionable, user-friendly
   * messages instead of raw fetch/HTTP errors.
   */
  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    try {
      yield* super.chat(request);
    } catch (err) {
      throw friendlySundayError(err);
    }
  }

  /**
   * Single-shot FIM completion via the hosted gateway. Same friendly
   * error mapping as chat(); AbortError propagates unchanged.
   */
  async complete(request: FimRequest): Promise<FimResult> {
    try {
      return await super.complete(request);
    } catch (err) {
      throw friendlySundayError(err);
    }
  }

  async listModels(): Promise<ModelEntry[]> {
    // Try the live model list; fall back to the baked-in default so the
    // provider is usable even when the gateway is briefly unreachable.
    // The 2s budget keeps model listing snappy offline (and in tests) —
    // a slow gateway must never block the IDE.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      (timer as unknown as { unref?: () => void }).unref?.();
      try {
        const res = await fetch(`${this.apiUrl()}/v1/models`, {
          headers: { Authorization: `Bearer ${process.env[this.envVar()]?.trim() ?? ''}` },
          signal: ctrl.signal,
        });
        if (res.ok) {
          const body = (await res.json()) as { data?: Array<{ id?: string }> };
          const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
          if (ids.length > 0) {
            return ids.map((id) => ({
              id,
              label: `${id} (Sunday hosted)`,
              contextWindow: 128_000,
              supportsTools: true,
              supportsFim: false,
            }));
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // fall through to default
    }
    return SUNDAY_DEFAULT_MODELS;
  }
}
