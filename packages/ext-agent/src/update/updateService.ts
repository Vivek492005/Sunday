// sunday-agent — UpdateService: checks the Sunday hosted gateway for new
// IDE releases and notifies the user. All VS Code and network access is
// injected via deps so this stays unit-testable with a mocked `vscode`.
//
// Auto-checks are silent (no UI when up-to-date or unreachable); manual
// checks always report the outcome.

export interface UpdateInfo {
  updateAvailable: boolean;
  current: string;
  latest: string | null;
  downloadUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
}

export interface UpdateServiceDeps {
  /** Fetch + parse JSON from a URL. */
  fetchJson: (url: string) => Promise<unknown>;
  /** e.g. 'win32', 'darwin', 'linux'. */
  platform: string;
  /** Current IDE version, e.g. '1.0.0'. */
  currentVersion: string;
  /** Gateway base URL, no trailing slash. */
  gatewayUrl: string;
  showInfoMessage: (message: string, ...items: string[]) => PromiseLike<string | undefined>;
  showErrorMessage: (message: string, ...items: string[]) => PromiseLike<string | undefined>;
  openExternal: (url: string) => PromiseLike<void>;
  /** Download the release asset and hand off to the OS installer. */
  downloadAndInstall: (info: UpdateInfo) => PromiseLike<void>;
  log: (msg: string) => void;
}

const DOWNLOAD_INSTALL = 'Download & Install';
const RELEASE_NOTES = 'Release Notes';
const LATER = 'Later';

function isUpdateInfo(v: unknown): v is UpdateInfo {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.updateAvailable === 'boolean' &&
    typeof o.current === 'string' &&
    (o.latest === null || typeof o.latest === 'string') &&
    (o.downloadUrl === null || typeof o.downloadUrl === 'string')
  );
}

export class UpdateService {
  constructor(private readonly deps: UpdateServiceDeps) {}

  private checkUrl(): string {
    const base = this.deps.gatewayUrl.replace(/\/$/, '');
    const params = new URLSearchParams({
      platform: this.deps.platform,
      current: this.deps.currentVersion,
    });
    return `${base}/updates/check?${params.toString()}`;
  }

  /** Returns the update info, or null when the check itself failed. */
  async fetchUpdateInfo(): Promise<UpdateInfo | null> {
    try {
      const raw = await this.deps.fetchJson(this.checkUrl());
      if (!isUpdateInfo(raw)) {
        this.deps.log('Sunday update check: unexpected gateway response shape');
        return null;
      }
      return raw;
    } catch (e) {
      this.deps.log(`Sunday update check failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Check for updates. When `manual` is true the user explicitly asked,
   * so the outcome is always reported. Automatic checks stay silent
   * unless an update is actually available.
   */
  async checkForUpdates(manual: boolean): Promise<void> {
    const info = await this.fetchUpdateInfo();
    if (!info) {
      if (manual) {
        await this.deps.showErrorMessage(
          'Could not check for Sunday updates. Check your connection and try again.',
        );
      }
      return;
    }
    if (!info.updateAvailable || !info.latest) {
      if (manual) {
        await this.deps.showInfoMessage(
          `You're on the latest version of Sunday (v${info.current}).`,
        );
      }
      return;
    }
    const choice = await this.deps.showInfoMessage(
      `Sunday v${info.latest} is available (you have v${info.current}).`,
      DOWNLOAD_INSTALL,
      RELEASE_NOTES,
      LATER,
    );
    if (choice === DOWNLOAD_INSTALL) {
      try {
        await this.deps.downloadAndInstall(info);
      } catch (e) {
        await this.deps.showErrorMessage(`Sunday update failed: ${(e as Error).message}`);
      }
    } else if (choice === RELEASE_NOTES) {
      await this.deps.openExternal('https://github.com/Vivek492005/Sunday/releases/latest');
    }
    // "Later" or dismissed: do nothing.
  }
}
