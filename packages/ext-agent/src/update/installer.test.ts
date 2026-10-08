// Tests for UpdateInstaller: platform-specific install handoff.
// The download layer and process spawning are mocked — no real downloads.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { UpdateInstaller, type InstallerDeps } from './installer.js';
import type { UpdateInfo } from './updateService.js';

const info: UpdateInfo = {
  updateAvailable: true,
  current: '1.0.0',
  latest: '1.0.1',
  downloadUrl: 'https://example.com/Sunday-Setup-1.0.1-win.exe',
  releaseNotes: null,
  publishedAt: null,
};

function makeDeps(overrides: Partial<InstallerDeps> = {}): InstallerDeps & {
  downloadFile: ReturnType<typeof vi.fn>;
  spawnDetached: ReturnType<typeof vi.fn>;
  quitIde: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
  showInfoMessage: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
} {
  const base: InstallerDeps = {
    platform: 'win32',
    downloadFile: vi.fn(async (_url, _dest, onProgress) => { onProgress(100); }),
    tmpdir: () => '/tmp',
    spawnDetached: vi.fn(),
    quitIde: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    showInfoMessage: vi.fn(async () => 'OK'),
    showErrorMessage: vi.fn(async () => undefined),
    withProgress: async (_title, task) => { await task(() => undefined); },
    log: vi.fn(),
  };
  return { ...base, ...overrides } as InstallerDeps & {
    downloadFile: ReturnType<typeof vi.fn>;
    spawnDetached: ReturnType<typeof vi.fn>;
    quitIde: ReturnType<typeof vi.fn>;
    openPath: ReturnType<typeof vi.fn>;
    showInfoMessage: ReturnType<typeof vi.fn>;
    showErrorMessage: ReturnType<typeof vi.fn>;
  };
}

describe('UpdateInstaller', () => {
  it('throws when there is no download URL', async () => {
    const deps = makeDeps();
    await expect(
      new UpdateInstaller(deps).downloadAndInstall({ ...info, downloadUrl: null }),
    ).rejects.toThrow('no download URL');
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  it('win32: downloads, launches installer detached, then quits the IDE', async () => {
    const deps = makeDeps({ platform: 'win32' });
    await new UpdateInstaller(deps).downloadAndInstall(info);
    expect(deps.downloadFile).toHaveBeenCalledWith(
      info.downloadUrl,
      expect.stringContaining('Sunday-Setup-1.0.1-win.exe'),
      expect.any(Function),
    );
    expect(deps.spawnDetached).toHaveBeenCalledWith(
      expect.stringContaining('Sunday-Setup-1.0.1-win.exe'),
      [],
    );
    expect(deps.quitIde).toHaveBeenCalled();
  });

  it('win32: quits only after the installer was spawned', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      platform: 'win32',
      spawnDetached: vi.fn(() => { order.push('spawn'); }),
      quitIde: vi.fn(async () => { order.push('quit'); }),
    });
    await new UpdateInstaller(deps).downloadAndInstall(info);
    expect(order).toEqual(['spawn', 'quit']);
  });

  it('darwin: downloads and opens the dmg', async () => {
    const macInfo = { ...info, downloadUrl: 'https://example.com/Sunday-1.0.1-mac.dmg' };
    const deps = makeDeps({ platform: 'darwin' });
    await new UpdateInstaller(deps).downloadAndInstall(macInfo);
    expect(deps.downloadFile).toHaveBeenCalled();
    expect(deps.openPath).toHaveBeenCalledWith(expect.stringContaining('.dmg'));
    expect(deps.quitIde).not.toHaveBeenCalled();
    expect(deps.showInfoMessage).toHaveBeenCalledWith(expect.stringContaining('Applications'), 'OK');
  });

  it('linux: downloads and shows extract instructions', async () => {
    const linuxInfo = { ...info, downloadUrl: 'https://example.com/sunday-1.0.1-linux.tar.gz' };
    const deps = makeDeps({ platform: 'linux' });
    await new UpdateInstaller(deps).downloadAndInstall(linuxInfo);
    expect(deps.downloadFile).toHaveBeenCalled();
    expect(deps.showInfoMessage).toHaveBeenCalledWith(expect.stringContaining('tar -xzf'), 'OK');
    expect(deps.quitIde).not.toHaveBeenCalled();
  });

  it('rejects unsupported platforms without launching anything', async () => {
    const deps = makeDeps({ platform: 'freebsd' });
    await expect(new UpdateInstaller(deps).downloadAndInstall(info)).rejects.toThrow(
      'not supported on freebsd',
    );
    expect(deps.spawnDetached).not.toHaveBeenCalled();
    expect(deps.quitIde).not.toHaveBeenCalled();
  });

  it('propagates download failures', async () => {
    const deps = makeDeps({
      downloadFile: vi.fn(async () => { throw new Error('network reset'); }),
    });
    await expect(new UpdateInstaller(deps).downloadAndInstall(info)).rejects.toThrow('network reset');
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });

  it('derives the temp file name from the download URL', async () => {
    const deps = makeDeps({ platform: 'win32' });
    await new UpdateInstaller(deps).downloadAndInstall(info);
    const destPath = deps.downloadFile.mock.calls[0][1] as string;
    expect(destPath).toContain('Sunday-Setup-1.0.1-win.exe');
  });
});
