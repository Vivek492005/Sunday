/**
 * Sunday IDE — updateManager tests (AUTO-UPDATE).
 *
 * Pure-logic tests with stubbed fetch/spawn — never the network, never a
 * real installer. Real asset names from the actual GitHub releases are
 * used throughout ('Sunday-Setup.exe', 'Sunday-UserSetup.exe',
 * 'Sunday-linux.tar.gz', 'Sunday-mac.dmg').
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareSemver,
  normalizeTag,
  pickPlatformAsset,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  __resetUpdateStateForTests,
  MIN_INSTALLER_BYTES,
} from './updateManager.js';

const ASSETS = [
  { name: 'Sunday-Setup.exe', browser_download_url: 'https://example.com/dl/Sunday-Setup.exe' },
  { name: 'Sunday-UserSetup.exe', browser_download_url: 'https://example.com/dl/Sunday-UserSetup.exe' },
  { name: 'Sunday-linux.tar.gz', browser_download_url: 'https://example.com/dl/Sunday-linux.tar.gz' },
  { name: 'Sunday-mac.dmg', browser_download_url: 'https://example.com/dl/Sunday-mac.dmg' },
  { name: 'sunday-agent.vsix', browser_download_url: 'https://example.com/dl/sunday-agent.vsix' },
];

function jsonFetchStub(handler: (url: string) => unknown) {
  return vi.fn(async (url: string) => {
    const data = handler(url);
    return {
      ok: true,
      status: 200,
      json: async () => data,
    } as unknown as Response;
  });
}

let tmpDir: string;

beforeEach(() => {
  __resetUpdateStateForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-update-test-'));
});

afterEach(() => {
  __resetUpdateStateForTests();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  const cases: Array<[string, string, -1 | 0 | 1]> = [
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '2.0.0', -1],
    ['2.0.0', '1.9.9', 1],
    ['1.0', '1.0.0', 0],
    ['1.2.3', '1.2.4', -1],
    ['2.0.1', '2.0.0', 1],
    ['10.0.0', '9.9.9', 1],
    // prereleases rank below the release they precede
    ['2.0.1-beta.3', '2.0.1', -1],
    ['2.0.1', '2.0.1-beta.3', 1],
    ['2.0.1-beta.3', '2.0.1-beta.3', 0],
    // semver §11 prerelease ordering chain
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-alpha.beta', '1.0.0-beta', -1],
    ['1.0.0-beta', '1.0.0-beta.2', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-beta.11', '1.0.0-rc.1', -1],
    ['1.0.0-rc.1', '1.0.0', -1],
    // numeric identifiers rank below alphanumeric ones
    ['1.0.0-1', '1.0.0-alpha', -1],
    // build metadata is ignored
    ['1.0.0+build.1', '1.0.0', 0],
    ['1.0.0+build.1', '1.0.0+build.2', 0],
    ['1.0.0-alpha+001', '1.0.0-alpha', 0],
    // leading v tolerated
    ['v1.2.3', '1.2.3', 0],
  ];
  for (const [a, b, expected] of cases) {
    it(`compareSemver(${a}, ${b}) === ${expected}`, () => {
      expect(compareSemver(a, b)).toBe(expected);
      // Antisymmetry: reversing the operands negates the result.
      const reversed = expected === 0 ? 0 : ((expected * -1) as -1 | 1);
      expect(compareSemver(b, a)).toBe(reversed);
    });
  }
});

// ---------------------------------------------------------------------------
// normalizeTag
// ---------------------------------------------------------------------------

describe('normalizeTag', () => {
  const cases: Array<[string, string]> = [
    ['sunday-ide-v2.0.1', '2.0.1'],
    ['v1.0.0', '1.0.0'],
    ['ide-v1.0.0', '1.0.0'],
    ['SUNDAY-IDE-V2.0.0', '2.0.0'],
    ['Sunday-Ide-v2.0.1', '2.0.1'],
    ['2.0.1', '2.0.1'],
    ['sunday-ide-2.0.1-beta.3', '2.0.1-beta.3'],
    ['sunday-ide-v2.0.1-beta.1', '2.0.1-beta.1'],
    ['  ide-v1.2.3  ', '1.2.3'],
    ['v2.0.1', '2.0.1'],
  ];
  for (const [input, expected] of cases) {
    it(`normalizeTag(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      expect(normalizeTag(input)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// pickPlatformAsset
// ---------------------------------------------------------------------------

describe('pickPlatformAsset', () => {
  it('win32 prefers the exact Sunday-Setup.exe over Sunday-UserSetup.exe', () => {
    const picked = pickPlatformAsset(ASSETS, 'win32');
    expect(picked).toEqual({ name: 'Sunday-Setup.exe', url: 'https://example.com/dl/Sunday-Setup.exe' });
  });

  it('win32 exact match is case-insensitive', () => {
    const picked = pickPlatformAsset(
      [{ name: 'SUNDAY-SETUP.EXE', browser_download_url: 'https://example.com/x' }],
      'win32',
    );
    expect(picked?.name).toBe('SUNDAY-SETUP.EXE');
  });

  it('win32 falls back to a UserSetup exe when it is the only setup exe', () => {
    const picked = pickPlatformAsset(
      ASSETS.filter((a) => a.name !== 'Sunday-Setup.exe'),
      'win32',
    );
    expect(picked?.name).toBe('Sunday-UserSetup.exe');
  });

  it('win32 falls back to any setup .exe, preferring a plain Setup over UserSetup', () => {
    const picked = pickPlatformAsset(
      [
        { name: 'Sunday-UserSetup.exe', browser_download_url: 'https://example.com/u' },
        { name: 'Acme-Setup.exe', browser_download_url: 'https://example.com/s' },
      ],
      'win32',
    );
    expect(picked?.name).toBe('Acme-Setup.exe');
  });

  it('win32 returns null when no exe exists', () => {
    expect(pickPlatformAsset([ASSETS[2], ASSETS[3]], 'win32')).toBeNull();
  });

  it('darwin prefers Sunday-mac.dmg, falls back to any .dmg', () => {
    expect(pickPlatformAsset(ASSETS, 'darwin')?.name).toBe('Sunday-mac.dmg');
    expect(
      pickPlatformAsset([{ name: 'Other.dmg', browser_download_url: 'https://example.com/o' }], 'darwin')?.name,
    ).toBe('Other.dmg');
    expect(pickPlatformAsset([ASSETS[0]], 'darwin')).toBeNull();
  });

  it('linux prefers Sunday-linux.tar.gz, falls back to any .tar.gz', () => {
    expect(pickPlatformAsset(ASSETS, 'linux')?.name).toBe('Sunday-linux.tar.gz');
    expect(
      pickPlatformAsset([{ name: 'app.tar.gz', browser_download_url: 'https://example.com/a' }], 'linux')?.name,
    ).toBe('app.tar.gz');
    expect(pickPlatformAsset([ASSETS[0]], 'linux')).toBeNull();
  });

  it('returns null for empty assets and unknown platforms', () => {
    expect(pickPlatformAsset([], 'win32')).toBeNull();
    expect(pickPlatformAsset(ASSETS, 'freebsd')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkForUpdates
// ---------------------------------------------------------------------------

describe('checkForUpdates', () => {
  it('gateway path success: returns the gateway result and never calls GitHub', async () => {
    const fetchImpl = jsonFetchStub((url) => {
      expect(url).toContain('/updates/check?');
      expect(url).toContain('platform=win32');
      expect(url).toContain('current=2.0.0');
      expect(url).toContain('channel=stable');
      return {
        updateAvailable: true,
        current: '2.0.0',
        latest: '2.0.1',
        downloadUrl: 'https://example.com/dl/Sunday-Setup.exe',
        releaseNotes: 'Bug fixes',
        publishedAt: '2026-10-20T00:00:00Z',
      };
    });
    const res = await checkForUpdates({
      gatewayUrl: 'https://gateway.example.com',
      currentVersion: '2.0.0',
      platform: 'win32',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.available).toBe(true);
    expect(res.source).toBe('gateway');
    expect(res.latest).toBe('2.0.1');
    expect(res.downloadUrl).toBe('https://example.com/dl/Sunday-Setup.exe');
    expect(res.assetName).toBe('Sunday-Setup.exe');
    expect(res.releaseNotes).toBe('Bug fixes');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gateway up-to-date: available=false from the gateway, no GitHub call', async () => {
    const fetchImpl = jsonFetchStub(() => ({
      updateAvailable: false,
      current: '2.0.1',
      latest: '2.0.1',
      downloadUrl: null,
      releaseNotes: null,
      publishedAt: null,
    }));
    const res = await checkForUpdates({
      gatewayUrl: 'https://gateway.example.com',
      currentVersion: '2.0.1',
      platform: 'linux',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.available).toBe(false);
    expect(res.source).toBe('gateway');
    expect(res.latest).toBe('2.0.1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gateway update without a URL falls back to GitHub and picks the real asset', async () => {
    const fetchImpl = jsonFetchStub((url) => {
      if (url.includes('/updates/check')) {
        return {
          updateAvailable: true,
          current: '2.0.0',
          latest: '2.0.1',
          downloadUrl: null,
          releaseNotes: null,
          publishedAt: null,
        };
      }
      expect(url).toBe('https://api.github.com/repos/Vivek492005/Sunday/releases/latest');
      return {
        tag_name: 'sunday-ide-v2.0.1',
        body: 'Release notes from GitHub',
        published_at: '2026-10-20T00:00:00Z',
        assets: ASSETS,
      };
    });
    const res = await checkForUpdates({
      gatewayUrl: 'https://gateway.example.com',
      currentVersion: '2.0.0',
      platform: 'win32',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.available).toBe(true);
    expect(res.source).toBe('github');
    expect(res.latest).toBe('2.0.1');
    // The gateway matcher bug must not leak through: Sunday-Setup.exe wins.
    expect(res.downloadUrl).toBe('https://example.com/dl/Sunday-Setup.exe');
    expect(res.assetName).toBe('Sunday-Setup.exe');
    expect(res.releaseNotes).toBe('Release notes from GitHub');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // GitHub call carries the required headers.
    const ghInit = (fetchImpl.mock.calls[1] as unknown[])[1] as { headers: Record<string, string> };
    expect(ghInit.headers.Accept).toBe('application/vnd.github+json');
    expect(ghInit.headers['User-Agent']).toBe('sunday-ide');
  });

  it('gateway shape from the real win32 matcher bug (updateAvailable=false, newer latest, no URL) still falls back', async () => {
    const fetchImpl = jsonFetchStub((url) => {
      if (url.includes('/updates/check')) {
        return {
          updateAvailable: false,
          current: '2.0.0',
          latest: '2.0.1',
          downloadUrl: null,
          releaseNotes: 'notes',
          publishedAt: '2026-10-20T00:00:00Z',
        };
      }
      return {
        tag_name: 'sunday-ide-v2.0.1',
        body: 'notes',
        published_at: '2026-10-20T00:00:00Z',
        assets: ASSETS,
      };
    });
    const res = await checkForUpdates({
      gatewayUrl: 'https://gateway.example.com',
      currentVersion: '2.0.0',
      platform: 'darwin',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.available).toBe(true);
    expect(res.source).toBe('github');
    expect(res.downloadUrl).toBe('https://example.com/dl/Sunday-mac.dmg');
  });

  it('gateway unreachable falls back to GitHub; GitHub no-newer → not available', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/updates/check')) throw new Error('network down');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v2.0.0',
          body: null,
          published_at: '2026-10-19T00:00:00Z',
          assets: ASSETS,
        }),
      } as unknown as Response;
    });
    const res = await checkForUpdates({
      gatewayUrl: 'https://gateway.example.com',
      currentVersion: '2.0.0',
      platform: 'win32',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.available).toBe(false);
    expect(res.source).toBe('github');
    expect(res.latest).toBe('2.0.0');
    expect(res.error).toBeUndefined();
  });

  it('uses the default gateway URL when none is provided', async () => {
    const fetchImpl = jsonFetchStub(() => ({
      updateAvailable: false,
      current: '2.0.1',
      latest: '2.0.1',
      downloadUrl: null,
      releaseNotes: null,
      publishedAt: null,
    }));
    await checkForUpdates({
      currentVersion: '2.0.1',
      platform: 'win32',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const firstUrl = (fetchImpl.mock.calls[0] as unknown[])[0] as string;
    expect(firstUrl.startsWith('https://sunday-final-ide.onrender.com/updates/check?')).toBe(true);
  });

  it('total failure resolves (never throws) with available=false and an error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const res = await checkForUpdates({
      gatewayUrl: 'https://gateway.example.com',
      currentVersion: '2.0.0',
      platform: 'win32',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.available).toBe(false);
    expect(res.error).toContain('offline');
  });
});

// ---------------------------------------------------------------------------
// downloadUpdate + installUpdate
// ---------------------------------------------------------------------------

function streamOfZeros(totalBytes: number, chunkBytes = 1024 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkBytes, totalBytes - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n));
    },
  });
}

function downloadFetchFor(body: string | ReadableStream<Uint8Array>): typeof fetch {
  return vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

describe('downloadUpdate / installUpdate', () => {
  it('rejects a small download as too small and deletes the file', async () => {
    const fetchImpl = downloadFetchFor('tiny — definitely not an installer');
    await expect(
      downloadUpdate({ fetchImpl, tmpDir }, 'https://example.com/dl/Sunday-Setup.exe'),
    ).rejects.toThrow('downloaded installer is too small to be a real Sunday installer');
    expect(fs.existsSync(path.join(tmpDir, 'Sunday-Setup.exe'))).toBe(false);
  });

  it('downloads a real-size installer (52MiB of zeros) and returns its path', async () => {
    const fetchImpl = downloadFetchFor(streamOfZeros(52 * 1024 * 1024));
    const filePath = await downloadUpdate(
      { fetchImpl, tmpDir },
      'https://example.com/dl/Sunday-Setup.exe',
    );
    expect(filePath).toBe(path.join(tmpDir, 'Sunday-Setup.exe'));
    const st = fs.statSync(filePath);
    expect(st.size).toBe(52 * 1024 * 1024);
    expect(st.size).toBeGreaterThan(MIN_INSTALLER_BYTES);
  });

  it('enforces the byte cap (override) — aborts and deletes the partial file', async () => {
    const fetchImpl = downloadFetchFor(streamOfZeros(8 * 1024, 1024));
    await expect(
      downloadUpdate(
        { fetchImpl, tmpDir, maxDownloadBytes: 4096, minInstallerBytes: 1 },
        'https://example.com/dl/Sunday-Setup.exe',
      ),
    ).rejects.toThrow('400MB maximum');
    expect(fs.existsSync(path.join(tmpDir, 'Sunday-Setup.exe'))).toBe(false);
  });

  it('concurrent-download guard: a second call while one runs throws', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enqueued = false;
    const slowStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await gate;
        if (!enqueued) {
          enqueued = true;
          controller.enqueue(new Uint8Array(16));
        } else {
          controller.close();
        }
      },
    });
    const fetchImpl = downloadFetchFor(slowStream);
    const first = downloadUpdate({ fetchImpl, tmpDir }, 'https://example.com/dl/Sunday-Setup.exe');
    // Attach a handler immediately so the eventual rejection is not unhandled.
    const firstSettled = first.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await expect(
      downloadUpdate({ fetchImpl, tmpDir }, 'https://example.com/dl/Sunday-Setup.exe'),
    ).rejects.toThrow('download already in progress');
    release();
    // The first download finishes but is far below the size floor.
    await expect(firstSettled).resolves.toContain('too small');
  });

  it('install refuses a path this process never downloaded', async () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    await expect(
      installUpdate(
        { spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn, platform: 'win32' },
        path.join(tmpDir, 'Sunday-Setup.exe'),
      ),
    ).rejects.toThrow('refusing to install');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('install refuses a different path even after a successful download', async () => {
    const fetchImpl = downloadFetchFor(streamOfZeros(52 * 1024 * 1024));
    await downloadUpdate({ fetchImpl, tmpDir }, 'https://example.com/dl/Sunday-Setup.exe');
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    await expect(
      installUpdate(
        { spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn, platform: 'win32' },
        path.join(tmpDir, 'Somebody-Elses-Setup.exe'),
      ),
    ).rejects.toThrow('refusing to install');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('win32 install launches the downloaded installer detached with /S and unrefs it', async () => {
    const fetchImpl = downloadFetchFor(streamOfZeros(52 * 1024 * 1024));
    const filePath = await downloadUpdate(
      { fetchImpl, tmpDir },
      'https://example.com/dl/Sunday-Setup.exe',
    );
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref }));
    await installUpdate(
      { spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn, platform: 'win32' },
      filePath,
    );
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const calls = spawnImpl.mock.calls as unknown as Array<[string, string[], { detached: boolean }]>;
    expect(calls[0][0]).toBe(filePath);
    expect(calls[0][1]).toEqual(['/S']);
    expect(calls[0][2].detached).toBe(true);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('darwin install opens the downloaded dmg via `open`', async () => {
    const fetchImpl = downloadFetchFor(streamOfZeros(52 * 1024 * 1024));
    const filePath = await downloadUpdate(
      { fetchImpl, tmpDir },
      'https://example.com/dl/Sunday-mac.dmg',
    );
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    await installUpdate(
      { spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn, platform: 'darwin' },
      filePath,
    );
    const calls = spawnImpl.mock.calls as unknown as Array<[string, string[]]>;
    expect(calls[0][0]).toBe('open');
    expect(calls[0][1]).toEqual([filePath]);
  });

  it('linux install opens the containing folder via xdg-open', async () => {
    const fetchImpl = downloadFetchFor(streamOfZeros(52 * 1024 * 1024));
    const filePath = await downloadUpdate(
      { fetchImpl, tmpDir },
      'https://example.com/dl/Sunday-linux.tar.gz',
    );
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    await installUpdate(
      { spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn, platform: 'linux' },
      filePath,
    );
    const calls = spawnImpl.mock.calls as unknown as Array<[string, string[]]>;
    expect(calls[0][0]).toBe('xdg-open');
    expect(calls[0][1]).toEqual([path.dirname(filePath)]);
  });

  it('install refuses when the downloaded file was deleted afterwards', async () => {
    const fetchImpl = downloadFetchFor(streamOfZeros(52 * 1024 * 1024));
    const filePath = await downloadUpdate(
      { fetchImpl, tmpDir },
      'https://example.com/dl/Sunday-Setup.exe',
    );
    fs.unlinkSync(filePath);
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    await expect(
      installUpdate(
        { spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn, platform: 'win32' },
        filePath,
      ),
    ).rejects.toThrow('no longer exists');
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
