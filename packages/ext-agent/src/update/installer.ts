// sunday-agent — Installer: downloads a Sunday IDE release asset and
// hands off to the OS for installation. The actual network download and
// process spawning are injected via deps so tests never touch the disk
// or launch installers.

import * as path from 'node:path';
import type { UpdateInfo } from './updateService.js';

export interface InstallerDeps {
  /** e.g. 'win32', 'darwin', 'linux'. */
  platform: string;
  /**
   * Stream `url` to `destPath`, calling onProgress with 0-100 as bytes
   * arrive. Must reject on any failure; must not leave partial files
   * on success paths (callers treat rejection as "try again later").
   */
  downloadFile: (url: string, destPath: string, onProgress: (pct: number) => void) => PromiseLike<void>;
  /** OS temp directory. */
  tmpdir: () => string;
  /** Launch a detached process (fire-and-forget). */
  spawnDetached: (cmd: string, args: string[]) => void;
  /** Quit the running IDE. */
  quitIde: () => PromiseLike<void>;
  /** Open a URL/file in the OS default handler. */
  openPath: (target: string) => PromiseLike<void>;
  showInfoMessage: (message: string, ...items: string[]) => PromiseLike<string | undefined>;
  showErrorMessage: (message: string) => PromiseLike<void>;
  withProgress: (
    title: string,
    task: (report: (pct: number) => void) => PromiseLike<void>,
  ) => PromiseLike<void>;
  log: (msg: string) => void;
}

function fileNameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').pop() ?? '';
    return name || 'sunday-update.bin';
  } catch {
    return 'sunday-update.bin';
  }
}

export class UpdateInstaller {
  constructor(private readonly deps: InstallerDeps) {}

  async downloadAndInstall(info: UpdateInfo): Promise<void> {
    if (!info.downloadUrl) throw new Error('no download URL for this update');
    const fileName = fileNameFromUrl(info.downloadUrl);
    const destPath = path.join(this.deps.tmpdir(), fileName);
    this.deps.log(`Sunday update: downloading ${info.downloadUrl}`);

    await this.deps.withProgress(`Downloading Sunday v${info.latest ?? ''}`, async (report) => {
      await this.deps.downloadFile(info.downloadUrl!, destPath, report);
    });

    switch (this.deps.platform) {
      case 'win32':
        await this.installWindows(destPath);
        break;
      case 'darwin':
        await this.installMac(destPath);
        break;
      case 'linux':
        await this.installLinux(destPath);
        break;
      default:
        throw new Error(`updates are not supported on ${this.deps.platform}; file saved to ${destPath}`);
    }
  }

  /** NSIS installers upgrade in place: launch detached, then quit the IDE. */
  private async installWindows(installerPath: string): Promise<void> {
    await this.deps.showInfoMessage(
      'Sunday installer downloaded. The IDE will close and the installer will start.',
      'OK',
    );
    this.deps.spawnDetached(installerPath, []);
    // Give the detached installer a moment to start before we exit.
    await new Promise((r) => setTimeout(r, 1500));
    await this.deps.quitIde();
  }

  private async installMac(dmgPath: string): Promise<void> {
    await this.deps.openPath(dmgPath);
    await this.deps.showInfoMessage(
      'Sunday disk image opened. Drag Sunday to Applications to finish updating, then restart the IDE.',
      'OK',
    );
  }

  private async installLinux(archivePath: string): Promise<void> {
    await this.deps.showInfoMessage(
      `Sunday update saved to ${archivePath}. Extract it and restart the IDE to finish updating. ` +
        'Example: tar -xzf ' +
        archivePath,
      'OK',
    );
  }
}
