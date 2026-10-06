import type { ModelInfo } from '@sunday/protocol';
import { GroqProvider, OllamaProvider, OpenRouterProvider } from './providers.js';
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

export function createDefaultRegistry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(new OpenRouterProvider());
  r.register(new GroqProvider());
  // Local Model slice: unconditional registration — *selection* is gated by
  // sunday.localModel.enabled, so a missing Ollama install changes nothing.
  r.register(new OllamaProvider());
  return r;
}
