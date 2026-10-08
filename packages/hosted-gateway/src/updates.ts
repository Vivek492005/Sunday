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
  assets: GitHubAsset[];
}

const GITHUB_LATEST_URL = 'https://api.github.com/repos/Vivek492005/Sunday/releases/latest';
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

export class UpdateChecker {
  private cached: { at: number; release: GitHubRelease } | null = null;
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;

  constructor(opts: { fetchImpl?: FetchImpl; now?: () => number } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async fetchLatestRelease(): Promise<GitHubRelease> {
    const now = this.now();
    if (this.cached && now - this.cached.at < CACHE_TTL_MS) {
      return this.cached.release;
    }
    // Retry once: Render's shared egress IPs can hit GitHub rate limits transiently.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(GITHUB_LATEST_URL, {
          headers: {
            Accept: 'application/vnd.github+json',
            // GitHub API requires a User-Agent.
            'User-Agent': 'sunday-hosted-gateway',
          },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`github api status ${res.status}`);
        const release = (await res.json()) as GitHubRelease;
        if (typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) {
          throw new Error('unexpected github api shape');
        }
        this.cached = { at: now, release };
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

  async check(platform: UpdatePlatform, current: string): Promise<UpdateCheckResult> {
    const base: UpdateCheckResult = {
      updateAvailable: false,
      current,
      latest: null,
      downloadUrl: null,
      releaseNotes: null,
      publishedAt: null,
    };
    let release: GitHubRelease;
    try {
      release = await this.fetchLatestRelease();
    } catch {
      // Never expose upstream error text to callers.
      return { ...base, error: 'update_check_failed' };
    }
    const latest = release.tag_name.replace(/^v/i, '');
    base.latest = latest;
    base.releaseNotes = release.body ?? null;
    base.publishedAt = release.published_at ?? null;
    // Prereleases never trigger an update on the stable channel.
    if (release.prerelease) return base;
    if (compareVersions(current, latest) >= 0) return base;
    const asset = findPlatformAsset(release.assets, platform);
    if (!asset) return base;
    return { ...base, updateAvailable: true, downloadUrl: asset.browser_download_url };
  }
}
