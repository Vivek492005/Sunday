import { describe, expect, it, vi } from 'vitest';
import {
  compareVersions,
  findPlatformAsset,
  UpdateChecker,
  type UpdatePlatform,
} from './updates.js';

const platforms: UpdatePlatform[] = ['win32', 'darwin', 'linux'];

function mockFetch(release: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(release),
  });
}

const baseRelease = {
  tag_name: 'v1.0.1',
  body: 'Bug fixes',
  published_at: '2026-10-08T00:00:00Z',
  prerelease: false,
  assets: [
    { name: 'Sunday-Setup-1.0.1-win.exe', browser_download_url: 'https://x/win.exe' },
    { name: 'Sunday-1.0.1-mac.dmg', browser_download_url: 'https://x/mac.dmg' },
    { name: 'Sunday-1.0.1-linux.tar.gz', browser_download_url: 'https://x/linux.tar.gz' },
  ],
};

describe('compareVersions', () => {
  it('orders basic versions', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
  it('handles multi-digit segments numerically', () => {
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
  });
  it('strips a leading v', () => {
    expect(compareVersions('v1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.0.1', 'v1.0.1')).toBe(0);
  });
  it('treats missing segments as zero', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1', '1.0.1')).toBe(-1);
  });
  it('ranks prereleases below the release', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });
  it('tolerates whitespace and junk', () => {
    expect(compareVersions(' 1.0.0 ', '1.0.0')).toBe(0);
    expect(compareVersions('abc', '0.0.0')).toBe(0);
  });
});

describe('findPlatformAsset', () => {
  it('matches per platform', () => {
    const assets = baseRelease.assets;
    expect(findPlatformAsset(assets, 'win32')?.browser_download_url).toBe('https://x/win.exe');
    expect(findPlatformAsset(assets, 'darwin')?.browser_download_url).toBe('https://x/mac.dmg');
    expect(findPlatformAsset(assets, 'linux')?.browser_download_url).toBe('https://x/linux.tar.gz');
  });
  it('is case-insensitive', () => {
    const assets = [{ name: 'SUNDAY-WIN-SETUP.EXE', browser_download_url: 'u' }];
    expect(findPlatformAsset(assets, 'win32')?.browser_download_url).toBe('u');
  });
  it('returns null when no asset matches', () => {
    expect(findPlatformAsset([], 'win32')).toBeNull();
    expect(findPlatformAsset([{ name: 'readme.txt', browser_download_url: 'u' }], 'darwin')).toBeNull();
  });
  it('rejects wrong extensions', () => {
    const assets = [{ name: 'sunday-win.zip', browser_download_url: 'u' }];
    expect(findPlatformAsset(assets, 'win32')).toBeNull();
  });
});

describe('UpdateChecker', () => {
  it('reports an update when the release is newer and has a platform asset', async () => {
    const checker = new UpdateChecker({ fetchImpl: mockFetch(baseRelease) as typeof fetch });
    for (const p of platforms) {
      const r = await checker.check(p, '1.0.0');
      expect(r.updateAvailable).toBe(true);
      expect(r.latest).toBe('1.0.1');
      expect(r.releaseNotes).toBe('Bug fixes');
      expect(r.publishedAt).toBe('2026-10-08T00:00:00Z');
      expect(r.downloadUrl).toMatch(/^https:\/\/x\//);
    }
  });
  it('reports no update when already current', async () => {
    const checker = new UpdateChecker({ fetchImpl: mockFetch(baseRelease) as typeof fetch });
    const r = await checker.check('win32', '1.0.1');
    expect(r.updateAvailable).toBe(false);
    expect(r.latest).toBe('1.0.1');
    expect(r.downloadUrl).toBeNull();
  });
  it('reports no update when current is newer', async () => {
    const checker = new UpdateChecker({ fetchImpl: mockFetch(baseRelease) as typeof fetch });
    const r = await checker.check('win32', '1.0.2');
    expect(r.updateAvailable).toBe(false);
  });
  it('never offers prereleases', async () => {
    const pre = { ...baseRelease, prerelease: true, tag_name: 'v2.0.0-beta.1' };
    const checker = new UpdateChecker({ fetchImpl: mockFetch(pre) as typeof fetch });
    const r = await checker.check('win32', '1.0.0');
    expect(r.updateAvailable).toBe(false);
  });
  it('reports no update when no platform asset exists', async () => {
    const noAssets = { ...baseRelease, assets: [] };
    const checker = new UpdateChecker({ fetchImpl: mockFetch(noAssets) as typeof fetch });
    const r = await checker.check('linux', '1.0.0');
    expect(r.updateAvailable).toBe(false);
    expect(r.latest).toBe('1.0.1');
  });
  it('hides upstream failures behind a generic error', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const checker = new UpdateChecker({ fetchImpl: failing as typeof fetch });
    const r = await checker.check('win32', '1.0.0');
    expect(r.updateAvailable).toBe(false);
    expect(r.error).toBe('update_check_failed');
  });
  it('hides non-OK GitHub statuses', async () => {
    const checker = new UpdateChecker({ fetchImpl: mockFetch({}, false) as typeof fetch });
    const r = await checker.check('win32', '1.0.0');
    expect(r.updateAvailable).toBe(false);
    expect(r.error).toBe('update_check_failed');
  });
  it('caches the GitHub response for 10 minutes', async () => {
    let now = 1_000_000;
    const fetchImpl = mockFetch(baseRelease) as unknown as typeof fetch;
    const checker = new UpdateChecker({ fetchImpl, now: () => now });
    await checker.check('win32', '1.0.0');
    await checker.check('win32', '1.0.0');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 10 * 60 * 1000 + 1;
    await checker.check('win32', '1.0.0');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('sends a User-Agent header (GitHub API requirement)', async () => {
    const fetchImpl = mockFetch(baseRelease) as unknown as typeof fetch;
    const checker = new UpdateChecker({ fetchImpl });
    await checker.check('win32', '1.0.0');
    const headers = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers['User-Agent']).toBeTruthy();
  });
});
