// sunday-agent — built-in extension entry point.
// Owns the sundayd sidecar lifecycle (SidecarManager), the typed HostBridge,
// status-bar health, command registration, and the Sunday Chat webview view.
// The Agent Manager arrives in Phase 4.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SidecarManager, type SidecarStatus } from './sidecar.js';
import { HostBridge } from './hostBridge.js';
import { ChatViewProvider } from './chatView.js';
import { ManagerViewProvider } from './managerView.js';
import { McpViewProvider } from './mcpView.js';
import {
  WORKSPACE_ENV,
  WORKSPACE_TRUSTED_ENV,
  confirmTrustWorkspace,
  confirmWorkspaceMcpServer,
  type TrustPrompt,
} from './trust.js';
import {
  VscodeSecretResolver,
  buildSecretEnv,
  secretEnvName,
} from './secretResolver.js';
import { registerInlineCompletion } from './inlineCompletion.js';
import { registerInlineEdit } from './inlineEdit.js';
import { registerCodeActions } from './codeActions.js';
import { registerGitCommitMessage } from './gitCommit.js';
import { registerTerminalExplain } from './terminalExplain.js';
import { registerOrchestrationCommands } from './orchestrationCommands.js';

const EXT_ID = 'sunday.sunday-agent';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Sunday');
  const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  const version = String(vscode.extensions.getExtension(EXT_ID)?.packageJSON?.version ?? '0.0.1');

  // -- workspace trust + MCP secrets (Part A) --------------------------------------
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Set by "Sunday: Trust Workspace"; overrides vscode.workspace.isTrusted for this session.
  let workspaceTrustOverride: boolean | undefined;
  const isTrusted = () => workspaceTrustOverride ?? vscode.workspace.isTrusted;
  const trustPrompt: TrustPrompt = {
    isWorkspaceTrusted: isTrusted,
    showWarningMessage: async (message, ...items) =>
      vscode.window.showWarningMessage(message, ...items),
  };

  // Pre-resolve secret:<key> refs from both mcp.json files into SUNDAY_MCP_SECRET_*
  // env vars handed to sundayd at spawn (stdio RPC is client→daemon only, so the
  // daemon cannot ask for secrets later).
  const secretResolver = new VscodeSecretResolver(context.secrets);
  let mcpSecretEnv: Record<string, string> = {};
  try {
    mcpSecretEnv = await buildSecretEnv(
      async (p) => {
        try {
          return await fs.promises.readFile(p, 'utf8');
        } catch {
          return undefined;
        }
      },
      path.join(os.homedir(), '.sunday', 'mcp.json'),
      wsRoot ? path.join(wsRoot, '.sunday', 'mcp.json') : undefined,
      secretResolver,
      log,
    );
  } catch (err) {
    log(`MCP secret pre-resolution failed: ${(err as Error).message}`);
  }

  const manager = new SidecarManager({
    extensionDir: context.extensionPath,
    clientVersion: version,
    readConfig: () => {
      const cfg = vscode.workspace.getConfiguration('sunday');
      return { sidecarPath: cfg.get<string>('sidecar.path', '') };
    },
    log,
    extraEnv: () => ({
      ...(wsRoot ? { [WORKSPACE_ENV]: wsRoot } : {}),
      [WORKSPACE_TRUSTED_ENV]: isTrusted() ? '1' : '0',
      ...mcpSecretEnv,
    }),
  });

  let bridge: HostBridge | undefined;
  let chatProvider: ChatViewProvider | undefined;
  let managerProvider: ManagerViewProvider | undefined;
  let mcpProvider: McpViewProvider | undefined;
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
    chatProvider?.notifyBridgeChanged();
    managerProvider?.notifyBridgeChanged();
    mcpProvider?.notifyBridgeChanged();
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

  // -- shared bridge helper ----------------------------------------------------------
  const ensureBridge = async (): Promise<HostBridge> => {
    const rpc = await manager.ensureReady();
    if (!bridge) {
      bridge = new HostBridge(rpc);
      log('HostBridge attached to sundayd');
      chatProvider?.notifyBridgeChanged();
      managerProvider?.notifyBridgeChanged();
      mcpProvider?.notifyBridgeChanged();
    }
    return bridge;
  };

  // -- chat webview ---------------------------------------------------------------
  chatProvider = new ChatViewProvider({
    extensionPath: context.extensionPath,
    getBridge: () => bridge,
    ensureBridge,
    getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    log,
  });

  // -- agent manager webview ------------------------------------------------------
  managerProvider = new ManagerViewProvider({
    extensionPath: context.extensionPath,
    getBridge: () => bridge,
    ensureBridge,
    getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    log,
  });

  // -- MCP panel (Part A) -----------------------------------------------------------
  mcpProvider = new McpViewProvider({
    getBridge: () => bridge,
    ensureBridge,
    log,
    isWorkspaceTrusted: isTrusted,
    confirmWorkspaceServerStart: (name) => confirmWorkspaceMcpServer(trustPrompt, name),
    requestTrustWorkspace: async () => {
      await vscode.commands.executeCommand('sunday.workspace.trust');
    },
  });

  // -- MCP command helpers (Part A) --------------------------------------------------
  const getBridgeForCommands = async (): Promise<HostBridge | undefined> => {
    try {
      return await ensureBridge();
    } catch (err) {
      log(`command: sidecar not ready: ${(err as Error).message}`);
      vscode.window.showErrorMessage('Sunday sidecar is not running. Start it with "Sunday: Restart Sidecar".');
      return undefined;
    }
  };

  const pickMcpServer = async (b: HostBridge, title: string) => {
    const { servers } = await b.mcpServersList();
    if (!servers.length) {
      vscode.window.showInformationMessage(
        'No MCP servers are configured. Add one to ~/.sunday/mcp.json or the workspace .sunday/mcp.json.',
      );
      return undefined;
    }
    return vscode.window.showQuickPick(
      servers.map((s) => ({
        label: s.name,
        description: `${s.scope} · ${s.transport} · ${s.state}${s.lastError ? ` · ${s.lastError}` : ''}`,
        name: s.name,
        scope: s.scope,
      })),
      { title, placeHolder: 'Select an MCP server' },
    );
  };

  const mcpServerCommand = async (action: 'start' | 'stop' | 'restart'): Promise<void> => {
    const b = await getBridgeForCommands();
    if (!b) return;
    const pick = await pickMcpServer(b, `Sunday MCP: ${action} server`);
    if (!pick) return;
    if ((action === 'start' || action === 'restart') && pick.scope === 'workspace' && !isTrusted()) {
      const ok = await confirmWorkspaceMcpServer(trustPrompt, pick.name);
      if (!ok) {
        log(`mcp command: ${action} of workspace server "${pick.name}" denied by user`);
        return;
      }
    }
    try {
      if (action === 'start') await b.mcpServerStart(pick.name);
      else if (action === 'stop') await b.mcpServerStop(pick.name);
      else await b.mcpServerRestart(pick.name);
      mcpProvider?.notifyBridgeChanged();
      vscode.window.showInformationMessage(
        `MCP server "${pick.name}" ${action}${action === 'stop' ? 'p' : ''}ed.`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`MCP ${action} failed for "${pick.name}": ${(err as Error).message}`);
    }
  };

  const trustWorkspaceCommand = async (): Promise<void> => {
    if (isTrusted()) {
      vscode.window.showInformationMessage('This workspace is already trusted.');
      return;
    }
    const ok = await confirmTrustWorkspace(trustPrompt);
    if (!ok) {
      vscode.window.showInformationMessage('Workspace remains untrusted for Sunday.');
      return;
    }
    workspaceTrustOverride = true;
    log('workspace trust override enabled — restarting sidecar to apply');
    await restartSidecar();
  };

  const storeMcpSecretCommand = async (): Promise<void> => {
    const key = await vscode.window.showInputBox({
      title: 'Sunday MCP: Store Secret',
      prompt: 'Secret key (as referenced by secret:<key> in mcp.json)',
      validateInput: (v) =>
        /^[A-Za-z0-9_.-]+$/.test(v.trim()) ? undefined : 'Use letters, digits, dot, dash, underscore.',
    });
    if (!key) return;
    const value = await vscode.window.showInputBox({
      title: 'Sunday MCP: Store Secret',
      prompt: `Value for "${key.trim()}" (stored in VS Code SecretStorage, never in mcp.json)`,
      password: true,
    });
    if (value === undefined) return;
    const k = key.trim();
    await context.secrets.store(k, value);
    mcpSecretEnv = { ...mcpSecretEnv, [secretEnvName(k)]: value };
    log(`MCP secret "${k}" stored in SecretStorage`);
    const choice = await vscode.window.showInformationMessage(
      `Secret "${k}" stored. Restart the sidecar to apply it to MCP servers?`,
      'Restart Sidecar',
      'Later',
    );
    if (choice === 'Restart Sidecar') await restartSidecar();
  };

  // -- commands ------------------------------------------------------------------
  context.subscriptions.push(
    output,
    statusBar,
    manager,
    statusSub,
    chatProvider,
    managerProvider,
    mcpProvider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ManagerViewProvider.viewType, managerProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(McpViewProvider.viewType, mcpProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('sunday.chat.focus', () => {
      void vscode.commands.executeCommand('sunday.chatView.focus');
    }),
    vscode.commands.registerCommand('sunday.manager.open', () => {
      void vscode.commands.executeCommand('sunday.managerView.focus');
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
    vscode.commands.registerCommand('sunday.mcp.startServer', () => mcpServerCommand('start')),
    vscode.commands.registerCommand('sunday.mcp.stopServer', () => mcpServerCommand('stop')),
    vscode.commands.registerCommand('sunday.mcp.restartServer', () => mcpServerCommand('restart')),
    vscode.commands.registerCommand('sunday.workspace.trust', () => trustWorkspaceCommand()),
    vscode.commands.registerCommand('sunday.mcp.storeSecret', () => storeMcpSecretCommand()),
  );

  // -- orchestration commands (parallel agents phase) -------------------------
  registerOrchestrationCommands(context, {
    getBridge: getBridgeForCommands,
    getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    getActiveRunId: () => managerProvider?.getActiveRunId(),
    openManagerView: () => {
      void vscode.commands.executeCommand('sunday.managerView.focus');
    },
    log,
  });

  // === Part B (editor intelligence: workers 1-3) ==============================
  // Worker 1 — ghost-text inline completions. registerInlineCompletion closes
  // over the bridge instance, and the bridge is recreated on sidecar
  // restart/crash, so (re-)register on every status change; the previous
  // provider is disposed first. Purely additive: a second status listener.
  let inlineCompletionSub: vscode.Disposable | undefined;
  const refreshInlineCompletion = (): void => {
    inlineCompletionSub?.dispose();
    inlineCompletionSub = undefined;
    if (bridge) {
      inlineCompletionSub = registerInlineCompletion(context, bridge);
      context.subscriptions.push(inlineCompletionSub);
    }
  };
  context.subscriptions.push(manager.onDidChangeStatus(() => refreshInlineCompletion()));
  refreshInlineCompletion();

  // Worker 2 — inline edit (Ctrl/Cmd+I).
  registerInlineEdit(context, {
    getBridge: () => bridge,
    ensureBridge: getBridgeForCommands,
    log,
  });

  // Worker 3 — code actions, commit-message generation, terminal explain.
  // Shared sending policy (see agentSend.ts): direct chatSend via the bridge,
  // then focus the chat view so the turn streams visibly.
  const partBCwd = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  registerCodeActions(context, { ensureBridge, getCwd: partBCwd, log });
  registerGitCommitMessage(context, { ensureBridge, getCwd: partBCwd, log });
  registerTerminalExplain(context, { ensureBridge, getCwd: partBCwd, log });

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
