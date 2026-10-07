import type { ModelInfo } from '@sunday/protocol';
import { GroqProvider, OllamaProvider, OpenRouterProvider, SundayHostedProvider } from './providers.js';
import type { ChatProvider } from './types.js';

/** Provider + model registry (§10.2). Model ids are namespaced "provider:id"
 *  so the router and UI can address any model unambiguously. */
export class ProviderRegistry {
  private providers = new Map<string, ChatProvider>();

  register(p: ChatProvider): void {
    if (this.providers.has(p.id)) throw new Error(`provider already registered: ${p.id}`);
    this.providers.set(p.id, p);
  }

  get(id: string): ChatProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    return p;
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    for (const p of this.providers.values()) {
      for (const m of await p.listModels()) {
        out.push({
          id: `${p.id}:${m.id}`,
          provider: p.id,
          label: m.label,
          contextWindow: m.contextWindow,
          supportsTools: m.supportsTools,
        });
      }
    }
    return out;
  }
}

export function createDefaultRegistry(only?: Array<'sunday' | 'openrouter' | 'groq' | 'ollama'>): ProviderRegistry {
  const r = new ProviderRegistry();
  const want = (id: 'sunday' | 'openrouter' | 'groq' | 'ollama') => !only || only.includes(id);
  // Sunday hosted first: zero-config for signed-in users (GitHub OAuth).
  // BYOK providers (OpenRouter/Groq) remain for power users with keys.
  if (want('sunday')) r.register(new SundayHostedProvider());
  if (want('openrouter')) r.register(new OpenRouterProvider());
  if (want('groq')) r.register(new GroqProvider());
  // Local Model slice: unconditional registration — *selection* is gated by
  // sunday.localModel.enabled, so a missing Ollama install changes nothing.
  if (want('ollama')) r.register(new OllamaProvider());
  return r;
}

/** Default model: Sunday hosted (zero-config). Falls back to OpenRouter
 *  only when the caller explicitly opts out of the hosted default. */
export const DEFAULT_MODEL = 'sunday:meta-llama/llama-3.3-70b-instruct';
