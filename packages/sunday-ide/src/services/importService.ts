/**
 * Renderer-side wrapper for the F13 "Bring everything with you" importer.
 * All heavy lifting runs in the Electron main process (via @sunday/skills);
 * this module is a thin typed bridge.
 */
import type {
  ImportDetectedSource,
  ImportPlan,
  ImportReport,
  SundayAPI,
} from '../../electron/preload';

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

export type { ImportDetectedSource, ImportPlan, ImportReport };

export const importService = {
  detect(workspaceDir: string): Promise<ImportDetectedSource[]> {
    return bridge().importer.detect(workspaceDir);
  },
  /** Dry-run: zero writes, full preview. */
  plan(workspaceDir: string): Promise<ImportPlan> {
    return bridge().importer.plan(workspaceDir);
  },
  apply(plan: ImportPlan): Promise<ImportReport> {
    return bridge().importer.apply(plan);
  },
};
