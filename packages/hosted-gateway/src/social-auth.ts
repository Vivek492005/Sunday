/**
 * @sunday/hosted-gateway — social OAuth identity (GitHub / Google / Microsoft).
 *
 * Sunday IDE users sign in with any of these providers in the editor.
 * The IDE passes the OAuth token as the Bearer credential; the gateway
 * verifies it against the provider's userinfo endpoint and uses the
 * provider-namespaced user id as the quota identity (e.g. `gh:123`,
 * `google:456`, `ms:789` — namespaced so ids can't collide).
 *
 * Verification results are cached for 5 minutes (positive) / 30 seconds
 * (negative) to avoid hammering provider APIs.
 */

export type SocialProvider = 'github' | 'google' | 'microsoft';

export interface SocialIdentity {
  provider: SocialProvider;
  /** Provider-namespaced stable id, e.g. `gh:12345`. The quota key. */
  key: string;
  /** Human-readable label for audit logs (login/email). */
  label: string;
}

interface CacheEntry {
  identity: SocialIdentity | null;
  expiresAt: number;
}

const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;

interface ProviderDef {
  userinfoUrl: string;
  userAgent: string;
  /** Extract (namespacedKey, label) from the userinfo body, or null. */
  parse: (body: Record<string, unknown>) => { key: string; label: string } | null;
}

const PROVIDERS: Record<SocialProvider, ProviderDef> = {
  github: {
    userinfoUrl: 'https://api.github.com/user',
    userAgent: 'sunday-hosted-gateway',
    parse: (b) => {
      if (typeof b.id !== 'number' || typeof b.login !== 'string') return null;
      return { key: `gh:${b.id}`, label: String(b.login) };
    },
  },
  google: {
    userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    userAgent: 'sunday-hosted-gateway',
    parse: (b) => {
      if (typeof b.sub !== 'string') return null;
      const email = typeof b.email === 'string' ? b.email : b.sub;
      return { key: `google:${b.sub}`, label: email };
    },
  },
  microsoft: {
    userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
    userAgent: 'sunday-hosted-gateway',
    parse: (b) => {
      if (typeof b.id !== 'string') return null;
      const label =
        typeof b.userPrincipalName === 'string'
          ? b.userPrincipalName
          : typeof b.displayName === 'string'
            ? b.displayName
            : b.id;
      return { key: `ms:${b.id}`, label };
    },
  },
};

export class SocialVerifier {
  private cache = new Map<string, CacheEntry>();
  private readonly enabled: SocialProvider[];

  constructor(enabled: SocialProvider[] = ['github', 'google', 'microsoft']) {
    this.enabled = enabled;
  }

  /** Try each enabled provider until one verifies the token. */
  async verify(token: string, signal?: AbortSignal): Promise<SocialIdentity | null> {
    if (!token) return null;

    // S8: hard timeout on the whole verification — a stalled OAuth provider
    // must not hold handler connections open indefinitely (DoS).
    const timeout = AbortSignal.timeout(8000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return this.verifyInner(token, combined);
  }

  private async verifyInner(token: string, signal: AbortSignal): Promise<SocialIdentity | null> {
    const cacheKey = token;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.identity;
    if (cached) this.cache.delete(cacheKey);

    if (this.cache.size > 10_000) {
      for (const [k, v] of this.cache) {
        if (v.expiresAt <= now) this.cache.delete(k);
      }
    }

    for (const provider of this.enabled) {
      const identity = await this.tryProvider(provider, token, signal);
      if (identity) {
        this.cache.set(cacheKey, { identity, expiresAt: now + POSITIVE_TTL_MS });
        return identity;
      }
    }

    // Negative cache: avoids hammering providers with bad tokens.
    this.cache.set(cacheKey, { identity: null, expiresAt: now + NEGATIVE_TTL_MS });
    return null;
  }

  private async tryProvider(
    provider: SocialProvider,
    token: string,
    signal?: AbortSignal,
  ): Promise<SocialIdentity | null> {
    const def = PROVIDERS[provider];
    let res: Response;
    try {
      res = await fetch(def.userinfoUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': def.userAgent,
        },
        signal,
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;

    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
    const parsed = def.parse(body);
    if (!parsed) return null;
    return { provider, key: parsed.key, label: parsed.label };
  }

  /** Test hook. */
  clearCache(): void {
    this.cache.clear();
  }
}
