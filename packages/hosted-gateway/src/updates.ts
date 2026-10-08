/**
 * @sunday/hosted-gateway — update check service.
 *
 * Serves `GET /updates/check?platform=win32|darwin|linux&current=1.0.0` so
 * installed Sunday IDE copies can discover new releases without manual
 * re-downloads. The endpoint is public (no auth — update checks must work
 * for signed-out users) but per-IP rate-limited by the server.
 *
 * Design notes:
 * - GitHub API responses are cached for 10 minutes; the public releases
 *   endpoint needs no auth.
 * - GitHub API failures never leak verbatim — callers get a generic
 *   `updateAvailable: false` with an `error` hint, never upstream text.
 * - `fetchImpl` is injectable so tests never hit the network.
 */

export type UpdatePlatform = 'win32' | 'darwin' | 'linux';

export interface UpdateCheckResult {
  updateAvailable: boolean;
  current: string;
  latest: string | null;
  downloadUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  /** Present only when the check itself failed (never upstream error text). */
  error?: string;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  body: string | null;
  published_at: string | null;
  prerelease: boolean;
  draft?: boolean;
  assets: GitHubAsset[];
}

const GITHUB_LATEST_URL = 'https://api.github.com/repos/Vivek492005/Sunday/releases/latest';
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Vivek492005/Sunday/releases?per_page=10';
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

type FetchImpl = typeof fetch;

/**
 * Compare two semver-ish version strings.
 * Returns -1 when a < b, 0 when equal, 1 when a > b.
 * Handles leading `v`, missing segments (1.0 == 1.0.0), and prereleases
 * (1.0.0-beta < 1.0.0). Non-numeric segments compare as 0.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const clean = v.trim().replace(/^v/i, '');
    const dashIdx = clean.indexOf('-');
    const core = dashIdx === -1 ? clean : clean.slice(0, dashIdx);
    const pre = dashIdx === -1 ? '' : clean.slice(dashIdx + 1);
    const nums = core.split('.').map((n) => {
      const parsed = parseInt(n, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    });
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] ?? 0;
    const nb = pb.nums[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  // A version without a prerelease tag outranks the same version with one.
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** Pick the release asset matching the caller's platform, or null. */
export function findPlatformAsset(
  assets: GitHubAsset[],
  platform: UpdatePlatform,
): GitHubAsset | null {
  const name = (a: GitHubAsset): string => a.name.toLowerCase();
  const match = (a: GitHubAsset): boolean => {
    const n = name(a);
    switch (platform) {
      case 'win32':
        return n.includes('win') && n.endsWith('.exe');
      case 'darwin':
        return n.includes('mac') && n.endsWith('.dmg');
      case 'linux':
        return n.includes('linux') && n.endsWith('.tar.gz');
    }
  };
  return assets.find(match) ?? null;
}

/**
 * Normalize a GitHub release tag to a comparable version string.
 * Handles: `v1.0.0`, `ide-v1.0.0-beta.1`, `1.0.0-beta.2`.
 * Strips any `ide-` prefix and leading `v`.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^ide-/i, '').replace(/^v/i, '');
}

/** True when a version string looks like a beta/prerelease. */
export function isBetaVersion(version: string): boolean {
  return /beta|alpha|rc/i.test(normalizeTag(version));
}

export class UpdateChecker {
  private cached: { at: number; channel: string; release: GitHubRelease } | null = null;
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;

  constructor(opts: { fetchImpl?: FetchImpl; now?: () => number } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async fetchLatestRelease(includePrerelease: boolean): Promise<GitHubRelease> {
    const now = this.now();
    // Cache is per-channel: beta and stable have separate entries.
    const cacheKey = includePrerelease ? 'beta' : 'stable';
    if (this.cached && this.cached.channel === cacheKey && now - this.cached.at < CACHE_TTL_MS) {
      return this.cached.release;
    }
    // Retry once: Render's shared egress IPs can hit GitHub rate limits transiently.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const url = includePrerelease ? GITHUB_RELEASES_URL : GITHUB_LATEST_URL;
        const res = await this.fetchImpl(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            // GitHub API requires a User-Agent.
            'User-Agent': 'sunday-hosted-gateway',
            // Optional: authenticated requests get 5,000/hr vs 60/hr for shared IPs.
            ...(process.env.GITHUB_TOKEN
              ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
              : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`github api status ${res.status}`);
        let release: GitHubRelease;
        if (includePrerelease) {
          // /releases returns newest-first; pick the first non-draft with assets.
          const releases = (await res.json()) as GitHubRelease[];
          if (!Array.isArray(releases)) throw new Error('unexpected github api shape');
          const found = releases.find(
            (r) => r && typeof r.tag_name === 'string' && !r.draft && Array.isArray(r.assets),
          );
          if (!found) throw new Error('no releases found');
          release = found;
        } else {
          release = (await res.json()) as GitHubRelease;
          if (typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) {
            throw new Error('unexpected github api shape');
          }
        }
        this.cached = { at: now, channel: cacheKey, release };
        return release;
      } catch (err) {
        lastErr = err;
        // Log server-side only — never expose upstream details to clients.
        console.error(`[updates] GitHub fetch attempt ${attempt + 1} failed:`, err instanceof Error ? err.message : err);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('github fetch failed');
  }

  async check(
    platform: UpdatePlatform,
    current: string,
    channel: 'stable' | 'beta' = 'stable',
  ): Promise<UpdateCheckResult> {
    const base: UpdateCheckResult = {
      updateAvailable: false,
      current,
      latest: null,
      downloadUrl: null,
      releaseNotes: null,
      publishedAt: null,
    };
    // Beta users get prereleases; stable users never do.
    // Auto-detect: if the client is already on a beta, use the beta channel.
    const useBeta = channel === 'beta' || isBetaVersion(current);
    let release: GitHubRelease;
    try {
      release = await this.fetchLatestRelease(useBeta);
    } catch {
      // Never expose upstream error text to callers.
      return { ...base, error: 'update_check_failed' };
    }
    const latest = normalizeTag(release.tag_name);
    base.latest = latest;
    base.releaseNotes = release.body ?? null;
    base.publishedAt = release.published_at ?? null;
    // Prereleases never trigger an update on the stable channel.
    if (release.prerelease && !useBeta) return base;
    if (compareVersions(normalizeTag(current), latest) >= 0) return base;
    const asset = findPlatformAsset(release.assets, platform);
    if (!asset) return base;
    return { ...base, updateAvailable: true, downloadUrl: asset.browser_download_url };
  }
}
