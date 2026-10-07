/**
 * @sunday/hosted-gateway — GitHub token identity.
 *
 * Sunday IDE users sign in with GitHub in the editor. The IDE passes the
 * GitHub OAuth token as the Bearer credential; the gateway verifies it
 * against api.github.com and uses the GitHub user id as the quota identity.
 *
 * Verification results are cached for 5 minutes to avoid hammering GitHub
 * on every request. Only `read:user` scope is needed — we read the user id
 * and login, nothing else.
 */

export interface GitHubIdentity {
  /** Numeric GitHub user id — the stable quota key. */
  id: number;
  /** GitHub login (for audit logs only). */
  login: string;
}

interface CacheEntry {
  identity: GitHubIdentity;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export class GitHubVerifier {
  private cache = new Map<string, CacheEntry>();
  private readonly apiBase: string;

  constructor(apiBase = 'https://api.github.com') {
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  /** Verify a GitHub OAuth token. Returns null when invalid/expired. */
  async verify(token: string, signal?: AbortSignal): Promise<GitHubIdentity | null> {
    if (!token) return null;

    const now = Date.now();
    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > now) return cached.identity;
    if (cached) this.cache.delete(token);

    // Opportunistic cache hygiene.
    if (this.cache.size > 10_000) {
      for (const [k, v] of this.cache) {
        if (v.expiresAt <= now) this.cache.delete(k);
      }
    }

    let res: Response;
    try {
      res = await fetch(`${this.apiBase}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'sunday-hosted-gateway',
        },
        signal,
      });
    } catch {
      return null; // network error → treat as unverifiable, not as valid
    }

    if (!res.ok) return null;

    let body: { id?: number; login?: string };
    try {
      body = (await res.json()) as { id?: number; login?: string };
    } catch {
      return null;
    }
    if (typeof body.id !== 'number' || typeof body.login !== 'string') return null;

    const identity = { id: body.id, login: body.login };
    this.cache.set(token, { identity, expiresAt: now + CACHE_TTL_MS });
    return identity;
  }

  /** Test hook: clear the cache. */
  clearCache(): void {
    this.cache.clear();
  }
}
