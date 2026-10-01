import type { ProviderRegistry } from './registry.js';
import type { ChatProvider } from './types.js';

/** Router skeleton (§10.5). Phase 1: resolve "provider:model" refs (or a bare
 *  id against the default provider). Phase 3 adds routing policies, the
 *  rate-limit scheduler, and the visible Relay fallback. */
export interface RouteRequest {
  model?: string;
}

export interface RouteResult {
  provider: ChatProvider;
  /** Bare provider-side model id (prefix stripped). */
  model: string;
}

export function parseModelRef(
  ref: string,
  fallback: string,
): { providerId: string; model: string } {
  const i = ref.indexOf(':');
  if (i > 0) return { providerId: ref.slice(0, i), model: ref.slice(i + 1) };
  const d = fallback.indexOf(':');
  return { providerId: fallback.slice(0, d), model: ref };
}

export class Router {
  constructor(
    private registry: ProviderRegistry,
    private defaultModel = 'openrouter:meta-llama/llama-3.3-70b-instruct',
  ) {}

  route(req: RouteRequest = {}): RouteResult {
    const raw = req.model ?? this.defaultModel;
    const { providerId, model } = parseModelRef(raw, this.defaultModel);
    return { provider: this.registry.get(providerId), model };
  }
}
