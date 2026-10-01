// sunday-agent — built-in extension entry point.
// Owns the sundayd sidecar lifecycle (SidecarManager), the typed HostBridge,
// status-bar health, and command registration. Chat UI arrives in Phase 1f;
// the Agent Manager in Phase 4.
import * as vscode from 'vscode';
import { SidecarManager, type SidecarStatus } from './sidecar.js';
import { HostBridge } from './hostBridge.js';

const EXT_ID = 'sunday.sunday-agent';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Sunday');
  const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  const version = String(vscode.extensions.getExtension(EXT_ID)?.packageJSON?.version ?? '0.0.1');

  const manager = new SidecarManager({
    extensionDir: context.extensionPath,
    clientVersion: version,
    readConfig: () => {
      const cfg = vscode.workspace.getConfiguration('sunday');
      return { sidecarPath: cfg.get<string>('sidecar.path', '') };
    },
    log,
  });

  let bridge: HostBridge | undefined;
  const refreshBridge = () => {
    const rpc = manager.getRpc();
    if (rpc && !bridge) {
      bridge = new HostBridge(rpc);
      log('HostBridge attached to sundayd');
    } else if (!rpc && bridge) {
      bridge.dispose();
      bridge = undefined;
      log('HostBridge detached');
    }
  };

  // -- status bar: sidecar health ------------------------------------------------
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'sunday.sidecar.status';
  const renderStatusBar = () => {
    const s: SidecarStatus = manager.getStatus();
    const info = manager.getServerInfo();
    const ver = info ? ` (sundayd v${info.version})` : '';
    switch (s) {
      case 'ready':
        statusBar.text = '$(check) Sunday';
        statusBar.tooltip = `Sunday agent — connected${ver}`;
        statusBar.backgroundColor = undefined;
        break;
      case 'starting':
        statusBar.text = '$(sync~spin) Sunday';
        statusBar.tooltip = 'Sunday agent — starting sundayd…';
        statusBar.backgroundColor = undefined;
        break;
      case 'crashed':
        statusBar.text = '$(error) Sunday';
        statusBar.tooltip = `Sunday agent — sundayd crashed${ver}. Run "Sunday: Restart Sidecar".`;
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'stopped':
      default:
        statusBar.text = '$(circle-outline) Sunday';
        statusBar.tooltip = 'Sunday agent — sundayd not running';
        statusBar.backgroundColor = undefined;
        break;
    }
    statusBar.show();
  };
  const statusSub = manager.onDidChangeStatus((s) => {
    refreshBridge();
    renderStatusBar();
    log(`sidecar status → ${s}`);
    if (s === 'crashed') {
      void vscode.window
        .showErrorMessage('Sunday sidecar crashed repeatedly.', 'Restart Sidecar')
        .then((choice) => {
          if (choice === 'Restart Sidecar') void restartSidecar();
        });
    }
  });
  refreshBridge();
  renderStatusBar();

  const restartSidecar = async (): Promise<void> => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Restarting Sunday sidecar…' },
      async () => {
        bridge?.dispose();
        bridge = undefined;
        await manager.restart();
      },
    );
    vscode.window.showInformationMessage('Sunday sidecar restarted.');
  };

  // -- commands ------------------------------------------------------------------
  context.subscriptions.push(
    output,
    statusBar,
    manager,
    statusSub,
    vscode.commands.registerCommand('sunday.chat.focus', () => {
      vscode.window.showInformationMessage('Sunday chat panel arrives in Phase 1f — the sidecar is already running.');
    }),
    vscode.commands.registerCommand('sunday.manager.open', () => {
      vscode.window.showInformationMessage('Agent Manager arrives in Phase 4.');
    }),
    vscode.commands.registerCommand('sunday.turn.stop', async () => {
      if (!bridge) {
        vscode.window.showInformationMessage('Sunday sidecar is not running.');
        return;
      }
      const cancelled = await bridge.cancelActiveTurn().catch(() => false);
      vscode.window.showInformationMessage(cancelled ? 'Sunday turn cancelled.' : 'No active Sunday turn.');
    }),
    vscode.commands.registerCommand('sunday.sidecar.restart', () => restartSidecar()),
    vscode.commands.registerCommand('sunday.sidecar.status', () => {
      const info = manager.getServerInfo();
      vscode.window.showInformationMessage(
        `Sunday sidecar: ${manager.getStatus()}${info ? ` (sundayd v${info.version})` : ''}`,
      );
    }),
  );

  // -- autostart -------------------------------------------------------------------
  if (vscode.workspace.getConfiguration('sunday').get<boolean>('sidecar.autoStart', true)) {
    manager.start().catch((err: Error) => {
      log(`sidecar autostart failed: ${err.message}`);
      void vscode.window
        .showErrorMessage(`Sunday sidecar failed to start: ${err.message}`, 'Retry')
        .then((choice) => {
          if (choice === 'Retry') manager.start().catch((e: Error) => log(`retry failed: ${e.message}`));
        });
    });
  } else {
    log('sidecar.autoStart is off — start with "Sunday: Restart Sidecar"');
  }

  log(`sunday-agent v${version} activated`);
}

export function deactivate(): void {
  // The SidecarManager is in context.subscriptions; its dispose() stops sundayd.
}
