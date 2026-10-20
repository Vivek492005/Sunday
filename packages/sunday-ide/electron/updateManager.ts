/**
 * Sunday IDE — updateManager.ts (AUTO-UPDATE: GitHub Releases feed)
 *
 * Pure logic for the IDE's self-update flow. NO electron imports — every
 * side effect (network, temp dir, process spawn) is injected via deps so
 * this module is unit-testable with stubbed fetch/spawn.
 *
 * Flow:
 *  1. checkForUpdates — ask the hosted gateway first
 *     (`GET {gatewayUrl}/updates/check?...&channel=stable`). The gateway
 *     caches GitHub, BUT its asset matcher looks for names containing
 *     'win' / 'mac' / 'linux' and therefore never matches the real
 *     release assets (`Sunday-Setup.exe`, `Sunday-mac.dmg`,
 *     `Sunday-linux.tar.gz`). So whenever the gateway cannot hand back a
 *     usable download URL for the latest release, we fall back to the
 *     GitHub Releases API directly and pick the asset with
 *     pickPlatformAsset, which matches the REAL asset names.
 *  2. downloadUpdate — stream the installer to the OS temp dir with a
 *     single-download guard, a hard 400MB cap, and a 50MB sanity floor
 *     (real Sunday installers are ~100MB; anything smaller is an error
 *     page or a truncated download, never a real installer).
 *  3. installUpdate — launch the downloaded installer detached. Refuses
 *     any path this process did not itself download. ONLY ever called
 *     after an explicit user click (IPC wiring lives in main.ts) —
 *     nothing here auto-installs.
 *
 * SAFETY: never spawn(process.execPath); no unbounded buffers (the
 * download is streamed chunk-by-chunk with a byte cap); every fetch has
 * an AbortController timeout.
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_GATEWAY_URL = 'https://sunday-final-ide.onrender.com';
export const GITHUB_LATEST_URL =
  'https://api.github.com/repos/Vivek492005/Sunday/releases/latest';

/** Hard cap for a downloaded installer: 400MB. Real installers are ~106MB. */
export const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024; // 419_430_400

/** Sanity floor: a real Sunday installer is never smaller than 50MB. */
export const MIN_INSTALLER_BYTES = 52_428_800; // 50 * 1024 * 1024

const DEFAULT_CHECK_TIMEOUT_MS = 15_000;
/** Downloads are large; the abort timeout bounds the whole transfer. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  available: boolean;
  latest?: string;
  downloadUrl?: string;
  assetName?: string;
  releaseNotes?: string;
  publishedAt?: string;
  source?: 'gateway' | 'github';
  error?: string;
}

export interface UpdateCheckDeps {
  gatewayUrl?: string;
  currentVersion: string;
  platform: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface UpdateDownloadDeps {
  fetchImpl?: typeof fetch;
  /** Directory to save the installer into. Defaults to os.tmpdir(). */
  tmpDir?: string;
  timeoutMs?: number;
  /** Test/advanced override; defaults to MAX_DOWNLOAD_BYTES. */
  maxDownloadBytes?: number;
  /** Test/advanced override; defaults to MIN_INSTALLER_BYTES. */
  minInstallerBytes?: number;
}

export type SpawnImpl = typeof spawn;

export interface UpdateInstallDeps {
  spawnImpl?: SpawnImpl;
  platform?: string;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

// ---------------------------------------------------------------------------
// Module state: the one in-flight download + the last completed download.
// installUpdate only trusts a path recorded here — never an arbitrary
// renderer-supplied path.
// ---------------------------------------------------------------------------

let downloadInProgress = false;
let lastDownload: { path: string; sizeBytes: number } | null = null;

/** Test helper: clear the in-flight guard and the last-download record. */
export function __resetUpdateStateForTests(): void {
  downloadInProgress = false;
  lastDownload = null;
}

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

interface ParsedVersion {
  core: number[];
  /** Prerelease identifiers, or null for a plain release. */
  pre: string[] | null;
}

function parseVersion(v: string): ParsedVersion {
  // Build metadata (`+build.5`) never affects precedence.
  const noBuild = v.trim().split('+')[0] ?? '';
  // Tolerate a leading `v` so raw tags can be compared directly.
  const noV = noBuild.replace(/^v/i, '');
  const dashIdx = noV.indexOf('-');
  const coreStr = dashIdx === -1 ? noV : noV.slice(0, dashIdx);
  const preStr = dashIdx === -1 ? null : noV.slice(dashIdx + 1);
  const core = coreStr.split('.').map((n) => {
    const parsed = parseInt(n, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
  return { core, pre: preStr === null ? null : preStr.split('.') };
}

function isNumericIdentifier(s: string): boolean {
  return /^\d+$/.test(s);
}

/**
 * Compare two semver strings: -1 when a < b, 0 when equal, 1 when a > b.
 * Handles prereleases per semver §11 ('2.0.1-beta.3' < '2.0.1';
 * numeric identifiers compare numerically and rank below alphanumeric
 * ones; a shorter prerelease list ranks below a longer one it prefixes)
 * and ignores build metadata.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const na = pa.core[i] ?? 0;
    const nb = pb.core[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  // Same core: a plain release outranks any prerelease of it.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const preLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < preLen; i++) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    if (ia === undefined) return -1; // a is a prefix of b → a < b
    if (ib === undefined) return 1;
    if (ia === ib) continue;
    const aNum = isNumericIdentifier(ia);
    const bNum = isNumericIdentifier(ib);
    if (aNum && bNum) return Number(ia) < Number(ib) ? -1 : 1;
    if (aNum) return -1; // numeric < alphanumeric
    if (bNum) return 1;
    return ia < ib ? -1 : 1;
  }
  return 0;
}

/**
 * Normalize a GitHub release tag to a bare version string. Strips the
 * leading prefixes 'sunday-ide-', 'ide-', 'v' — in that order,
 * case-insensitive — so 'sunday-ide-v2.0.1' → '2.0.1' and
 * 'v1.0.0' → '1.0.0'.
 */
export function normalizeTag(tag: string): string {
  let s = tag.trim();
  if (/^sunday-ide-/i.test(s)) s = s.slice('sunday-ide-'.length);
  if (/^ide-/i.test(s)) s = s.slice('ide-'.length);
  if (/^v/i.test(s)) s = s.slice(1);
  return s.trim();
}

// ---------------------------------------------------------------------------
// Platform asset picking — matches the REAL release asset names.
// (The gateway's matcher requires 'win'/'mac' in the name and misses
// 'Sunday-Setup.exe' entirely; this picker is the correct one.)
// ---------------------------------------------------------------------------

export function pickPlatformAsset(
  assets: Array<{ name: string; browser_download_url: string }>,
  platform: string,
): { name: string; url: string } | null {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const toOut = (a: { name: string; browser_download_url: string }) => ({
    name: a.name,
    url: a.browser_download_url,
  });
  const lower = (a: { name: string }) => a.name.toLowerCase();

  switch (platform) {
    case 'win32': {
      const exact = assets.find((a) => lower(a) === 'sunday-setup.exe');
      if (exact) return toOut(exact);
      const setupExes = assets.filter(
        (a) => lower(a).endsWith('.exe') && lower(a).includes('setup'),
      );
      if (setupExes.length === 0) return null;
      // Prefer a plain Setup installer over a UserSetup one when both exist.
      const plain = setupExes.filter((a) => !lower(a).includes('usersetup'));
      return toOut(plain[0] ?? setupExes[0]);
    }
    case 'darwin': {
      const exact = assets.find((a) => lower(a) === 'sunday-mac.dmg');
      if (exact) return toOut(exact);
      const dmg = assets.find((a) => lower(a).endsWith('.dmg'));
      return dmg ? toOut(dmg) : null;
    }
    case 'linux': {
      const exact = assets.find((a) => lower(a) === 'sunday-linux.tar.gz');
      if (exact) return toOut(exact);
      const tar = assets.find((a) => lower(a).endsWith('.tar.gz'));
      return tar ? toOut(tar) : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// checkForUpdates
// ---------------------------------------------------------------------------

interface GatewayCheckResponse {
  updateAvailable?: boolean;
  current?: string;
  latest?: string | null;
  downloadUrl?: string | null;
  releaseNotes?: string | null;
  publishedAt?: string | null;
  error?: string;
}

interface GitHubReleaseResponse {
  tag_name?: string;
  body?: string | null;
  published_at?: string | null;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`request failed (${res.status})`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (!name) return undefined;
    return decodeURIComponent(name);
  } catch {
    return undefined;
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Check whether a newer Sunday release exists. Gateway first, GitHub
 * Releases as fallback. Never throws — a total failure resolves to
 * `{ available: false, error }`.
 */
export async function checkForUpdates(deps: UpdateCheckDeps): Promise<UpdateCheckResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const gatewayUrl = (deps.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/$/, '');
  const { currentVersion, platform } = deps;

  let gatewayError: string | null = null;

  // --- 1. Gateway ---------------------------------------------------------
  try {
    const url =
      `${gatewayUrl}/updates/check?platform=${encodeURIComponent(platform)}` +
      `&current=${encodeURIComponent(currentVersion)}&channel=stable`;
    const raw = await fetchJson(fetchImpl, url, { Accept: 'application/json' }, timeoutMs);
    const gw = (raw ?? {}) as GatewayCheckResponse;
    if (typeof gw === 'object') {
      if (gw.updateAvailable && gw.downloadUrl) {
        return {
          available: true,
          latest: gw.latest ? normalizeTag(gw.latest) : undefined,
          downloadUrl: gw.downloadUrl,
          assetName: fileNameFromUrl(gw.downloadUrl),
          releaseNotes: gw.releaseNotes ?? undefined,
          publishedAt: gw.publishedAt ?? undefined,
          source: 'gateway',
        };
      }
      const gwLatest = gw.latest ? normalizeTag(gw.latest) : undefined;
      const gwHasNewer =
        gwLatest !== undefined && compareSemver(currentVersion, gwLatest) < 0;
      if (!gw.updateAvailable && !gwHasNewer && !gw.error) {
        // The gateway authoritatively reports "up to date".
        return {
          available: false,
          latest: gwLatest,
          releaseNotes: gw.releaseNotes ?? undefined,
          publishedAt: gw.publishedAt ?? undefined,
          source: 'gateway',
        };
      }
      // Gateway knows about an update (or a newer latest) but gave us no
      // download URL — its platform matcher misses the real Windows asset
      // name — or the gateway check itself failed. Fall through to GitHub.
      gatewayError =
        gw.error ??
        (gw.updateAvailable
          ? 'gateway reported an update without a download URL'
          : 'gateway provided no download URL for the latest release');
    } else {
      gatewayError = 'gateway returned an unexpected response';
    }
  } catch (e) {
    gatewayError = errMessage(e);
  }

  // --- 2. GitHub Releases fallback ---------------------------------------
  try {
    const raw = await fetchJson(
      fetchImpl,
      GITHUB_LATEST_URL,
      { Accept: 'application/vnd.github+json', 'User-Agent': 'sunday-ide' },
      timeoutMs,
    );
    const rel = (raw ?? {}) as GitHubReleaseResponse;
    if (typeof rel.tag_name !== 'string' || !Array.isArray(rel.assets)) {
      throw new Error('unexpected GitHub releases response');
    }
    const latest = normalizeTag(rel.tag_name);
    const releaseNotes = rel.body ?? undefined;
    const publishedAt = rel.published_at ?? undefined;
    if (compareSemver(currentVersion, latest) >= 0) {
      return { available: false, latest, releaseNotes, publishedAt, source: 'github' };
    }
    const asset = pickPlatformAsset(rel.assets, platform);
    if (!asset) {
      return {
        available: false,
        latest,
        releaseNotes,
        publishedAt,
        source: 'github',
        error: `Sunday v${latest} is available but no installer was found for platform '${platform}'`,
      };
    }
    return {
      available: true,
      latest,
      downloadUrl: asset.url,
      assetName: asset.name,
      releaseNotes,
      publishedAt,
      source: 'github',
    };
  } catch (e) {
    const githubError = errMessage(e);
    return {
      available: false,
      error:
        `update check failed: gateway: ${gatewayError ?? 'unreachable'}; ` +
        `github: ${githubError}`,
    };
  }
}

// ---------------------------------------------------------------------------
// downloadUpdate
// ---------------------------------------------------------------------------

async function deleteFileQuietly(filePath: string): Promise<void> {
  try {
    await fsPromises.unlink(filePath);
  } catch {
    // already gone — deletion is best-effort cleanup
  }
}

/**
 * Stream `url` to `<tmpDir>/<assetName>` and return the file path.
 * Throws 'download already in progress' when a download is running.
 * Aborts + deletes the partial file past the byte cap; deletes + throws
 * when the finished file is below the installer sanity floor.
 */
export async function downloadUpdate(deps: UpdateDownloadDeps, url: string): Promise<string> {
  if (downloadInProgress) {
    throw new Error('download already in progress');
  }
  downloadInProgress = true;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = deps.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  const minBytes = deps.minInstallerBytes ?? MIN_INSTALLER_BYTES;
  const assetName = path.basename(fileNameFromUrl(url) ?? 'Sunday-Setup.exe');
  const destPath = path.join(tmpDir, assetName);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fsPromises.mkdir(tmpDir, { recursive: true });
    // fetch follows redirects automatically (GitHub asset URLs redirect
    // to a signed CDN URL).
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'sunday-ide' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`download failed (${res.status})`);

    let total = 0;
    const ws = fs.createWriteStream(destPath);
    const writeChunk = async (chunk: Uint8Array): Promise<void> => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error('download exceeds the 400MB maximum size for a Sunday installer');
      }
      if (!ws.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            ws.removeListener('error', onError);
            resolve();
          };
          const onError = (e: Error) => {
            ws.removeListener('drain', onDrain);
            reject(e);
          };
          ws.once('drain', onDrain);
          ws.once('error', onError);
        });
      }
    };

    try {
      const body = res.body as unknown;
      if (body && typeof (body as { getReader?: unknown }).getReader === 'function') {
        const reader = (
          body as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } }
        ).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            try {
              await writeChunk(value);
            } catch (e) {
              try {
                await reader.cancel();
              } catch {
                // stream already broken — the original error matters
              }
              throw e;
            }
          }
        }
      } else if (
        body &&
        typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
          'function'
      ) {
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          await writeChunk(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
        }
      } else if (typeof res.arrayBuffer === 'function') {
        const buf = Buffer.from(await res.arrayBuffer());
        await writeChunk(buf);
      } else {
        throw new Error('download failed: empty response body');
      }
    } finally {
      await new Promise<void>((resolve) => {
        ws.once('error', () => resolve());
        ws.end(() => resolve());
      });
    }

    const st = await fsPromises.stat(destPath);
    const sizeBytes = st.size;
    if (sizeBytes < minBytes) {
      await deleteFileQuietly(destPath);
      if (lastDownload?.path === destPath) lastDownload = null;
      throw new Error('downloaded installer is too small to be a real Sunday installer');
    }
    lastDownload = { path: destPath, sizeBytes };
    return destPath;
  } catch (e) {
    // Never leave a partial/oversized file behind, and never keep a
    // last-download record pointing at a file we just deleted.
    await deleteFileQuietly(destPath);
    if (lastDownload?.path === destPath) lastDownload = null;
    throw e;
  } finally {
    clearTimeout(timer);
    downloadInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// installUpdate
// ---------------------------------------------------------------------------

/**
 * Launch a previously downloaded installer, detached, so it outlives the
 * IDE process. Refuses any path that downloadUpdate did not produce in
 * this process, any missing file, and any file below the sanity floor.
 * Call ONLY after an explicit user click.
 */
export async function installUpdate(
  deps: UpdateInstallDeps,
  filePath: string,
): Promise<void> {
  const spawnImpl: SpawnImpl = deps.spawnImpl ?? spawn;
  const platform = deps.platform ?? process.platform;

  if (!lastDownload || filePath !== lastDownload.path) {
    throw new Error('refusing to install: file was not downloaded by this process');
  }
  let sizeBytes: number;
  try {
    sizeBytes = (await fsPromises.stat(filePath)).size;
  } catch {
    throw new Error('refusing to install: downloaded installer no longer exists');
  }
  if (sizeBytes < MIN_INSTALLER_BYTES) {
    throw new Error('refusing to install: installer is too small to be a real Sunday installer');
  }

  let child: ReturnType<SpawnImpl>;
  switch (platform) {
    case 'win32':
      // NSIS silent-install flag; the installer upgrades in place.
      child = spawnImpl(filePath, ['/S'], { detached: true, stdio: 'ignore' });
      break;
    case 'darwin':
      child = spawnImpl('open', [filePath], { detached: true, stdio: 'ignore' });
      break;
    case 'linux':
      // A .tar.gz is not executable — open its folder so the user can
      // extract it and restart into the new version.
      child = spawnImpl('xdg-open', [path.dirname(filePath)], {
        detached: true,
        stdio: 'ignore',
      });
      break;
    default:
      throw new Error(`updates are not supported on platform '${platform}'`);
  }
  // Audit L1: a spawned child with no 'error' listener throws in main
  // when the exe can't launch — the realistic Windows case is AV
  // quarantining the fresh download between the stat above and this
  // spawn. Log it instead of crashing the app at install time. (Guarded
  // by typeof: injected spawn fakes in tests may not implement .on.)
  const childRec = child as unknown as {
    on?: (ev: string, fn: (e: Error) => void) => void;
    unref?: () => void;
  } | null;
  if (childRec && typeof childRec.on === 'function') {
    childRec.on('error', (e) => {
      console.error('[sunday] update installer failed to launch:', e);
    });
  }
  (child as { unref?: () => void } | null)?.unref?.();
}
