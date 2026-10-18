/**
 * Typed access to the Sunday extensions bridge (`window.sunday.extensions`).
 * Open VSX registry browsing + VSIX install into ~/.sunday-ide/extensions.
 *
 * NOTE: there is no extension host yet — installed extensions are inert
 * until the host lands (follow-up). This wave ships the full UI +
 * install/uninstall mechanics.
 */
import type {
  SundayAPI,
  OpenVsxExtension,
  InstalledExtension,
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

export const extensionsService = {
  search(query: string): Promise<OpenVsxExtension[]> {
    return bridge().extensions.search(query);
  },
  list(): Promise<InstalledExtension[]> {
    return bridge().extensions.list();
  },
  install(ext: OpenVsxExtension): Promise<{ ok: boolean; error?: string }> {
    return bridge().extensions.install(ext);
  },
  uninstall(id: string): Promise<{ ok: boolean; error?: string }> {
    return bridge().extensions.uninstall(id);
  },
  setEnabled(id: string, enabled: boolean): Promise<void> {
    return bridge().extensions.setEnabled(id, enabled);
  },
};

export type { OpenVsxExtension, InstalledExtension };
