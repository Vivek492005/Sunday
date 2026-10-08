// Tests for UpdateService: check flow, notifications, silent auto-checks.
// `vscode` is mocked; all VS Code UI and network access is injected.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { UpdateService, type UpdateInfo, type UpdateServiceDeps } from './updateService.js';

const updateAvailable: UpdateInfo = {
  updateAvailable: true,
  current: '1.0.0',
  latest: '1.0.1',
  downloadUrl: 'https://example.com/sunday.exe',
  releaseNotes: 'Fixes',
  publishedAt: '2026-10-08T00:00:00Z',
};

const upToDate: UpdateInfo = {
  updateAvailable: false,
  current: '1.0.1',
  latest: '1.0.1',
  downloadUrl: null,
  releaseNotes: null,
  publishedAt: null,
};

function makeDeps(overrides: Partial<UpdateServiceDeps> = {}): UpdateServiceDeps & {
  showInfoMessage: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  downloadAndInstall: ReturnType<typeof vi.fn>;
  fetchJson: ReturnType<typeof vi.fn>;
} {
  const base: UpdateServiceDeps = {
    fetchJson: vi.fn(async () => upToDate),
    platform: 'win32',
    currentVersion: '1.0.1',
    gatewayUrl: 'https://gateway.example.com',
    showInfoMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    downloadAndInstall: vi.fn(async () => undefined),
    log: vi.fn(),
  };
  return { ...base, ...overrides } as UpdateServiceDeps & {
    showInfoMessage: ReturnType<typeof vi.fn>;
    showErrorMessage: ReturnType<typeof vi.fn>;
    openExternal: ReturnType<typeof vi.fn>;
    downloadAndInstall: ReturnType<typeof vi.fn>;
    fetchJson: ReturnType<typeof vi.fn>;
  };
}

describe('UpdateService.fetchUpdateInfo', () => {
  it('builds the gateway URL with platform and current version', async () => {
    const fetchJson = vi.fn(async () => upToDate);
    const deps = makeDeps({ fetchJson, platform: 'darwin', currentVersion: '1.0.0' });
    await new UpdateService(deps).fetchUpdateInfo();
    expect(fetchJson).toHaveBeenCalledWith(
      'https://gateway.example.com/updates/check?platform=darwin&current=1.0.0',
    );
  });
  it('returns null on network failure', async () => {
    const deps = makeDeps({ fetchJson: vi.fn(async () => { throw new Error('down'); }) });
    expect(await new UpdateService(deps).fetchUpdateInfo()).toBeNull();
  });
  it('returns null on malformed gateway responses', async () => {
    const deps = makeDeps({ fetchJson: vi.fn(async () => ({ nonsense: true })) });
    expect(await new UpdateService(deps).fetchUpdateInfo()).toBeNull();
  });
});

describe('UpdateService.checkForUpdates', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('manual check reports "latest" when up to date', async () => {
    await new UpdateService(deps).checkForUpdates(true);
    expect(deps.showInfoMessage).toHaveBeenCalledWith(
      expect.stringContaining('latest version'),
    );
    expect(deps.downloadAndInstall).not.toHaveBeenCalled();
  });

  it('auto check stays silent when up to date', async () => {
    await new UpdateService(deps).checkForUpdates(false);
    expect(deps.showInfoMessage).not.toHaveBeenCalled();
    expect(deps.showErrorMessage).not.toHaveBeenCalled();
  });

  it('manual check reports an error when the gateway is unreachable', async () => {
    deps.fetchJson = vi.fn(async () => { throw new Error('down'); });
    await new UpdateService(deps).checkForUpdates(true);
    expect(deps.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Could not check'));
  });

  it('auto check stays silent when the gateway is unreachable', async () => {
    deps.fetchJson = vi.fn(async () => { throw new Error('down'); });
    await new UpdateService(deps).checkForUpdates(false);
    expect(deps.showErrorMessage).not.toHaveBeenCalled();
    expect(deps.showInfoMessage).not.toHaveBeenCalled();
  });

  it('prompts on update and installs on "Download & Install"', async () => {
    deps.fetchJson = vi.fn(async () => updateAvailable);
    deps.showInfoMessage = vi.fn(async () => 'Download & Install');
    await new UpdateService(deps).checkForUpdates(false);
    expect(deps.showInfoMessage).toHaveBeenCalledWith(
      expect.stringContaining('v1.0.1 is available'),
      'Download & Install',
      'Release Notes',
      'Later',
    );
    expect(deps.downloadAndInstall).toHaveBeenCalledWith(updateAvailable);
  });

  it('opens release notes on "Release Notes"', async () => {
    deps.fetchJson = vi.fn(async () => updateAvailable);
    deps.showInfoMessage = vi.fn(async () => 'Release Notes');
    await new UpdateService(deps).checkForUpdates(false);
    expect(deps.openExternal).toHaveBeenCalledWith(
      'https://github.com/Vivek492005/Sunday/releases/latest',
    );
    expect(deps.downloadAndInstall).not.toHaveBeenCalled();
  });

  it('does nothing on "Later" or dismissal', async () => {
    deps.fetchJson = vi.fn(async () => updateAvailable);
    for (const choice of ['Later', undefined]) {
      deps.showInfoMessage = vi.fn(async () => choice as string);
      await new UpdateService(deps).checkForUpdates(false);
      expect(deps.downloadAndInstall).not.toHaveBeenCalled();
      expect(deps.openExternal).not.toHaveBeenCalled();
    }
  });

  it('shows an error when install fails', async () => {
    deps.fetchJson = vi.fn(async () => updateAvailable);
    deps.showInfoMessage = vi.fn(async () => 'Download & Install');
    deps.downloadAndInstall = vi.fn(async () => { throw new Error('disk full'); });
    await new UpdateService(deps).checkForUpdates(true);
    expect(deps.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
    );
  });
});
