// sunday-agent — F6 Durable Sessions: "Sunday: Restore Previous Settings".
//
// Lists the daemon's settings snapshots (auto-taken before every upgrade)
// and restores the picked one. The daemon always takes a pre-restore backup
// first, so the restore itself is reversible.

import * as vscode from 'vscode';
import type { RpcClient } from './rpc.js';

/** Command id: restore a previous settings snapshot. */
export const SETTINGS_RESTORE_COMMAND = 'sunday.settings.restore';

interface SnapshotInfo {
  id: string;
  createdAt: string;
  reason: string;
  bytes: number;
}

export interface SettingsRestoreDeps {
  /** Live RPC client to sundayd (from SidecarManager.getRpc()). */
  getRpc: () => RpcClient | undefined;
  log?: (msg: string) => void;
}

function formatSnapshot(s: SnapshotInfo): string {
  const when = new Date(s.createdAt).toLocaleString();
  return `${when} — ${s.reason} (${(s.bytes / 1024).toFixed(1)} KB)`;
}

export function registerSettingsRestoreCommand(
  context: vscode.ExtensionContext,
  deps: SettingsRestoreDeps,
): vscode.Disposable {
  const log = deps.log ?? (() => undefined);
  return vscode.commands.registerCommand(SETTINGS_RESTORE_COMMAND, async () => {
    const rpc = deps.getRpc();
    if (!rpc) {
      void vscode.window.showWarningMessage('Sunday daemon is not running — cannot list settings snapshots.');
      return;
    }
    let snapshots: SnapshotInfo[];
    try {
      const raw = (await rpc.request('settings/snapshots', {}, { timeoutMs: 10000 })) as {
        snapshots: SnapshotInfo[];
      };
      snapshots = raw.snapshots ?? [];
    } catch (e) {
      log(`settings snapshots failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`Could not list settings snapshots: ${(e as Error).message}`);
      return;
    }
    if (snapshots.length === 0) {
      void vscode.window.showInformationMessage('No settings snapshots yet — one is taken automatically before each upgrade.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      snapshots.map((s) => ({ label: formatSnapshot(s), id: s.id })),
      { placeHolder: 'Restore which settings snapshot? (current settings are backed up first)' },
    );
    if (!pick) return;
    const confirm = await vscode.window.showWarningMessage(
      `Restore settings from ${pick.label}? Your current settings will be backed up first.`,
      { modal: true },
      'Restore',
    );
    if (confirm !== 'Restore') return;
    try {
      await rpc.request('settings/restore', { id: pick.id }, { timeoutMs: 15000 });
      void vscode.window.showInformationMessage('Settings restored. Reload the window to apply them fully.');
    } catch (e) {
      log(`settings restore failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`Settings restore failed: ${(e as Error).message}`);
    }
  });
}
