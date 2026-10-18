/**
 * Typed access to Sunday settings (`~/.sunday-ide/settings.json` via IPC).
 * `applySettings` pushes values live: CSS theme on <html>, Monaco options
 * via a window event the editor subscribes to.
 */
import type { SundayAPI, SundaySettings } from '../../electron/preload';

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

export const DEFAULT_SETTINGS: SundaySettings = {
  theme: 'sunday-dark',
  editorFontSize: 13.5,
  editorFontFamily: "'JetBrains Mono', 'Cascadia Code', ui-monospace, Menlo, Consolas, monospace",
  editorTabSize: 2,
  editorWordWrap: false,
  terminalFontSize: 13,
};

/** Merge a partial settings object over the defaults (pure, tested). */
export function withDefaults(partial: Partial<SundaySettings>): SundaySettings {
  return { ...DEFAULT_SETTINGS, ...partial };
}

export const SETTINGS_APPLIED_EVENT = 'sunday:settings-applied';

/**
 * Apply settings live: theme via data-theme on <html>, editor options via a
 * CustomEvent that EditorArea listens for.
 */
export function applySettings(settings: SundaySettings): void {
  const theme = settings.theme === 'sunday-light' ? 'sunday-light' : 'sunday-dark';
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new CustomEvent<SundaySettings>(SETTINGS_APPLIED_EVENT, { detail: settings }));
}

export const settingsService = {
  async get(): Promise<SundaySettings> {
    try {
      const s = await bridge().settings.get();
      return withDefaults(s ?? {});
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  async set(patch: Partial<SundaySettings>): Promise<SundaySettings> {
    const next = await bridge().settings.set(patch);
    const merged = withDefaults(next ?? {});
    applySettings(merged);
    return merged;
  },
};

export type { SundaySettings };
