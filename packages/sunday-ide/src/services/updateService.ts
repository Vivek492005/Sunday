/**
 * Sunday Auto-Update service — typed access to the `window.sunday.update`
 * bridge. All heavy lifting (gateway/GitHub check, streaming download,
 * installer launch) runs in the Electron main process
 * (electron/updateManager.ts); this module is a thin typed bridge.
 *
 * SHARED TYPES: `UpdateCheckResult` and `UpdateDownloadResult` below are
 * the canonical shapes for the update feature. The coordinator mirrors
 * them into electron/preload.ts as `UpdateCheckOut` /
 * `UpdateDownloadOut` and types `SundayAPI.update` with them — the shapes
 * MUST stay in sync (structural typing makes them interchangeable).
 */
import type { SundayAPI } from '../../electron/preload';

/** Mirrors UpdateCheckResult in electron/updateManager.ts. */
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

export interface UpdateDownloadResult {
  path: string;
  sizeBytes: number;
}

/** The preload-side update bridge (mirrored on SundayAPI.update). */
export interface UpdateBridge {
  check(): Promise<UpdateCheckResult>;
  download(url: string): Promise<UpdateDownloadResult>;
  install(path: string): Promise<void>;
}

declare global {
  interface Window {
    sunday?: SundayAPI;
  }
}

function bridge(): SundayAPI {
  const api = window.sunday;
  if (!api) {
    throw new Error(
      'Sunday bridge unavailable — the Sunday IDE renderer must run inside the Electron shell (`pnpm dev`).',
    );
  }
  return api;
}

function update(): UpdateBridge {
  const api = bridge() as SundayAPI & { update?: UpdateBridge };
  if (!api.update) {
    throw new Error(
      'Sunday update bridge unavailable — the Electron main process does not expose updates in this build.',
    );
  }
  return api.update;
}

/** Broadcast the latest check result so the status-bar pill stays in sync. */
function broadcastStatus(result: UpdateCheckResult): void {
  try {
    window.dispatchEvent(new CustomEvent('sunday:update:status', { detail: result }));
  } catch {
    // CustomEvent unavailable (non-DOM test env) — the caller still has the result.
  }
}

export const updateService = {
  /**
   * Check the gateway (with GitHub Releases fallback in the main process).
   * Never rejects for a failed check — the main process resolves with
   * `{ available: false, error }`. Also broadcasts
   * 'sunday:update:status' for the UpdatePill.
   */
  async check(): Promise<UpdateCheckResult> {
    const result = await update().check();
    broadcastStatus(result);
    return result;
  },
  /** Stream the installer to the OS temp dir. Rejects on failure. */
  download(url: string): Promise<UpdateDownloadResult> {
    return update().download(url);
  },
  /**
   * Launch a previously downloaded installer (detached). The main
   * process refuses any path it did not download itself. Call ONLY from
   * an explicit user click.
   */
  install(path: string): Promise<void> {
    return update().install(path);
  },
};
