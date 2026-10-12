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
  /** Compute the SHA-256 hex digest of a file on disk. */
  computeSha256: (filePath: string) => PromiseLike<string>;
  /** Delete a file. Used to remove unverified downloads; best-effort. */
  deleteFile: (filePath: string) => PromiseLike<void>;
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

    // SECURITY GATE: never execute a download that fails checksum
    // verification. A mismatch means the file was corrupted or tampered
    // with — delete it and abort before any install step runs.
    await this.verifyDownload(info, destPath);

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

  /**
   * Verify the downloaded release asset against the SHA-256 checksum the
   * gateway provided. Throws (after deleting the file) on any mismatch or
   * hashing failure, so execution/installation never happens.
   *
   * When the gateway did not provide a checksum, verification is skipped
   * with a warning — existing functionality is preserved while the
   * gateway catches up (follow-up: include `sha256` in /updates/check
   * responses).
   */
  private async verifyDownload(info: UpdateInfo, destPath: string): Promise<void> {
    const expected = (info.sha256 ?? '').trim().toLowerCase();
    if (!expected) {
      this.deps.log(
        'Sunday update: WARNING — gateway did not provide a SHA-256 checksum; ' +
          'installing without verification.',
      );
      return;
    }
    this.deps.log('Sunday update: verifying download checksum...');
    let actual: string;
    try {
      actual = (await this.deps.computeSha256(destPath)).trim().toLowerCase();
    } catch (e) {
      await this.removeDownload(destPath);
      throw new Error(
        `Update verification failed: could not compute the checksum of the downloaded file (${(e as Error).message}). ` +
          'The file has been deleted and was not installed.',
      );
    }
    if (actual !== expected) {
      await this.removeDownload(destPath);
      throw new Error(
        'Update verification failed: the downloaded file does not match the expected checksum. ' +
          'The file has been deleted and was not installed.',
      );
    }
    this.deps.log('Sunday update: checksum verified.');
  }

  /** Best-effort delete of an unverified download. Never throws. */
  private async removeDownload(destPath: string): Promise<void> {
    try {
      await this.deps.deleteFile(destPath);
    } catch (e) {
      this.deps.log(
        `Sunday update: could not delete unverified download at ${destPath}: ${(e as Error).message}`,
      );
    }
  }

  /** NSIS installers upgrade in place: launch detached, then quit the IDE. */
  private async installWindows(installerPath: string): Promise<void> {    await this.deps.showInfoMessage(
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
