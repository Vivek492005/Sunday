// sunday-agent — built-in extension entry point.
// Spawns the sundayd sidecar over JSON-RPC/stdio (§5.3, §23) and hosts the
// HostBridge executors that need the vscode API (§9.2).
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const hello = vscode.commands.registerCommand('sunday.chat.focus', () => {
    vscode.window.showInformationMessage('Sunday agent: sidecar not yet wired (Phase 1).');
  });
  context.subscriptions.push(hello);
}

export function deactivate() {}
