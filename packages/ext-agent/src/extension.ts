// sunday-agent — built-in extension entry point.
// Owns the sundayd sidecar lifecycle (SidecarManager), the typed HostBridge,
// status-bar health, command registration, and the Sunday Chat webview view.
// The Agent Manager arrives in Phase 4.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { SidecarManager, BROWSER_ENABLED_ENV, LOCAL_MODEL_ENABLED_ENV, SANDBOX_MODE_ENV, SANDBOX_DOCKER_IMAGE_ENV, type SidecarStatus } from './sidecar.js';
import { HostBridge } from './hostBridge.js';
import { ChatViewProvider } from './chatView.js';
import { ManagerViewProvider, ManagerPanelManager } from './managerView.js';
import { McpViewProvider } from './mcpView.js';
import { BrowserViewProvider } from './browserPanel.js';
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
import { registerNextEdit } from './nextEdit.js';
import { registerCodeActions } from './codeActions.js';
import { registerGitCommitMessage } from './gitCommit.js';
import { registerTerminalExplain } from './terminalExplain.js';
import { registerDesignToCode } from './design-to-code.js';
import { registerOnboardRepo } from './onboarding/index.js';
import { registerOrchestrationCommands } from './orchestrationCommands.js';
import { getCachedView } from './entitlements/provider.js';
import { BROWSER_PLAN_MESSAGE, browserAllowedByView } from './entitlements/browserGating.js';
import { canUseBrowserAgent } from './entitlements/types.js';
import { registerMemoryPanel } from './memoryPanel.js';
import { registerRulesView } from './rulesView.js';
import { registerSwarmWebview } from './swarmWebview.js';
import { registerUsageCommands } from './usage/usagePanel.js';
import { registerSyncCommands } from './sync.js';
import { registerMarketplaceCommands } from './skills-marketplace/panel.js';
import { registerProactiveMode } from './proactiveMode.js';
import { registerAgentsMd } from './agentsMd.js';
import { registerStyleInfer } from './styleInfer.js';
import { registerInitProject } from './templates/initProject.js';
import { AGENT_MODE_ENV, getAgentMode, registerAgentModes } from './modes.js';
import { registerMemoryApplyFrom, type CrossProjectMemory, type CrossProjectStore } from './memoryApply.js';
import { AgentSender } from './agentSend.js';
import { STYLE_AUTOINFER_ENV, projectIdFor } from '@sunday/context';
import {
  registerAccountStatusBar,
  GOOGLE_AUTH_EXTENSION_ID,
  GOOGLE_SIGN_OUT_COMMAND,
} from './accountView.js';
import { registerStreakEngagement } from './engagement/streakView.js';
import { registerGitHubCommands } from './githubRepos.js';
import {
  createEntitlementsCache,
  sourceLabel,
  type SundaySessionLike,
} from './entitlements/entitlementsCache.js';
import { setEntitlementsProvider } from './entitlements/provider.js';
import { defaultCloudTaskDeps, registerCloudTaskCommands } from './cloudTasks.js';
import { registerBestOfN } from './bestOfNView.js';
import { registerArtifacts } from './artifacts/artifactsPanel.js';
import { registerSchedulerCommands, makeSchedulerSource } from './scheduler.js';
import { registerMissionControl } from './mission-control/missionControl.js';
import { defaultAdminPlanDeps, registerAdminPlanCommand } from './adminPlan.js';
import { UpdateService, type UpdateInfo } from './update/updateService.js';
import { UpdateInstaller } from './update/installer.js';
import { randomUUID } from 'node:crypto';
import { DAEMON_BOOT_TOKEN_ENV } from '@sunday/protocol';

const EXT_ID = 'sunday.sunday-agent';

/** Smoke-test hooks exposed via `activate()` return value (see bottom of activate). */
export interface SundaySmokeApi {
  getSidecarStatus: () => string;
  getServerInfo: () => { name: string; version: string } | undefined;
  ensureStarted: () => Promise<unknown>;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<{ __sundaySmoke: SundaySmokeApi } | void> {
  const output = vscode.window.createOutputChannel('Sunday');
  const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  const version = String(vscode.extensions.getExtension(EXT_ID)?.packageJSON?.version ?? '0.0.1');

  // -- workspace trust + MCP secrets (Part A) --------------------------------------
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // S3: per-boot daemon token. Generated here, stamped into sundayd's env at
  // spawn, and included in sensitive RPC params. Any other local process on
  // the socket without this token cannot approve tools or start servers.
  const daemonBootToken = randomUUID();
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

  // Task 7 (Gated touchpoints): the browser agent is plan-gated. Only
  // stamp SUNDAY_BROWSER_ENABLED when the user opted in AND the cached
  // entitlements allow the browser agent. Fail OPEN when entitlements are
  // unknown (provider not registered / no cache yet) — the panel and the
  // daemon re-check before doing anything.
  const browserEnabledForSidecar = (): boolean => {
    if (!vscode.workspace.getConfiguration('sunday').get<boolean>('browser.enabled', false)) {
      return false;
    }
    const view = getCachedView(log);
    if (view && !canUseBrowserAgent(view)) {
      log(
        'browser: sunday.browser.enabled is on but the plan excludes the browser agent — browserd will not start',
      );
      return false;
    }
    return true;
  };

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
      // S3: per-boot token for sensitive daemon RPCs.
      [DAEMON_BOOT_TOKEN_ENV]: daemonBootToken,
      // Agent browser opt-in (Browser Agent UI phase): sundayd only enables
      // browserd when this is '1'. Applies on the next sidecar (re)start.
      // Task 7: the browser agent is plan-gated — a plan without the
      // browser agent never starts browserd, even with the opt-in on.
      // Fail OPEN when entitlements are unknown (no cache yet); the panel
      // and the daemon re-check before doing anything.
      ...(browserEnabledForSidecar() ? { [BROWSER_ENABLED_ENV]: '1' } : {}),
      // Local model (Ollama) for ghost-text completions: sundayd tries the
      // `ollama` provider first (3s timeout) and silently falls back to the
      // API provider chain on any failure. Applies on the next sidecar (re)start.
      ...(vscode.workspace.getConfiguration('sunday').get<boolean>('localModel.enabled', false)
        ? { [LOCAL_MODEL_ENABLED_ENV]: '1' }
        : {}),
      // Sandbox execution for agent shell commands (Hardening phase):
      // sundayd reads SUNDAY_SANDBOX_MODE/DOCKER_IMAGE via sandboxConfigFromEnv.
      // Always stamped (default 'off'); applies on the next sidecar (re)start.
      ...(() => {
        const scfg = vscode.workspace.getConfiguration('sunday.sandbox');
        const env: Record<string, string> = {
          [SANDBOX_MODE_ENV]: scfg.get<string>('mode', 'off'),
        };
        const image = scfg.get<string>('dockerImage', '').trim();
        if (image) env[SANDBOX_DOCKER_IMAGE_ENV] = image;
        return env;
      })(),
      // Group B2: style auto-inference (once per project, first session).
      // Disabled by `sunday.style.autoInfer` (default true); applies on the
      // next sidecar (re)start.
      ...(vscode.workspace.getConfiguration('sunday.style').get<boolean>('autoInfer', true)
        ? {}
        : { [STYLE_AUTOINFER_ENV]: '0' }),
      // Group B4: agent mode (auto/architect/implementer/reviewer), persisted
      // per workspace in workspaceState. The daemon enforces it in the agent
      // loop's tool-dispatch path. Applies on the next sidecar (re)start.
      [AGENT_MODE_ENV]: getAgentMode(context.workspaceState),
      ...mcpSecretEnv,
    }),
  });

  let bridge: HostBridge | undefined;
  let chatProvider: ChatViewProvider | undefined;
  let managerProvider: ManagerViewProvider | undefined;
  let managerPanel: ManagerPanelManager | undefined;
  let mcpProvider: McpViewProvider | undefined;
  let browserProvider: BrowserViewProvider | undefined;

  // -- Sunday hosted gateway (zero-config AI) ---------------------------------------
  // When the user is signed in with GitHub, Microsoft, or Google in the IDE,
  // pass their OAuth token to sundayd so the `sunday` (hosted) provider works
  // without API keys. Silent: never prompts — if there's no session, BYOK
  // providers remain.
  const configureSundayHosted = async (): Promise<void> => {
    try {
      // Provider id → scopes. VS Code bundles github + microsoft auth;
      // google has no bundled provider and resolves to undefined gracefully.
      const candidates: Array<{ provider: string; scopes: string[] }> = [
        { provider: 'github', scopes: ['read:user'] },
        { provider: 'microsoft', scopes: ['User.Read'] },
        { provider: 'google', scopes: ['openid', 'email', 'profile'] },
      ];
      let token: string | undefined;
      let usedProvider: string | undefined;
      for (const c of candidates) {
        try {
          const session = await vscode.authentication.getSession(c.provider, c.scopes, {
            createIfNone: false,
            silent: true,
          });
          if (session?.accessToken) {
            token = session.accessToken;
            usedProvider = c.provider;
            break;
          }
        } catch {
          // Provider not available (e.g. no Google auth extension) — try next.
        }
      }
      if (!token) return;
      const rpc = await manager.ensureReady();
      await rpc.request(
        'daemon/configure',
        {
          workspaceRoot: wsRoot ?? process.cwd(),
          sundayApiToken: token,
        },
        { timeoutMs: 15000 },
      );
      log(`Sunday hosted gateway configured (${usedProvider} sign-in)`);
    } catch (e) {
      // Non-fatal: hosted provider stays unconfigured, BYOK still works.
      log(`Sunday hosted gateway not configured: ${(e as Error).message}`);
    }
  };
  // Fire-and-forget: must not block activation.
  void configureSundayHosted();

  const refreshBridge = () => {
    const rpc = manager.getRpc();
    if (rpc && !bridge) {
      bridge = new HostBridge(rpc, 30000, { bootToken: daemonBootToken });
      log('HostBridge attached to sundayd');
    } else if (!rpc && bridge) {
      bridge.dispose();
      bridge = undefined;
      log('HostBridge detached');
    }
    chatProvider?.notifyBridgeChanged();
    managerProvider?.notifyBridgeChanged();
    managerPanel?.notifyBridgeChanged();
    mcpProvider?.notifyBridgeChanged();
    browserProvider?.notifyBridgeChanged();
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
      bridge = new HostBridge(rpc, 30000, { bootToken: daemonBootToken });
      log('HostBridge attached to sundayd');
      chatProvider?.notifyBridgeChanged();
      managerProvider?.notifyBridgeChanged();
      managerPanel?.notifyBridgeChanged();
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
    // Task 7: local daily counter for the managed-model picker gate.
    globalState: context.globalState,
    log,
  });

  // -- agent manager webview ------------------------------------------------------
  // Sidebar WebviewView (legacy, kept registered for now) and the editor-area
  // WebviewPanel (P-030 Stage 1 — the canonical surface; `sunday.manager.open`
  // reveals it). Both share HTML + message routing via ManagerWebviewController.
  managerProvider = new ManagerViewProvider({
    extensionPath: context.extensionPath,
    getBridge: () => bridge,
    ensureBridge,
    getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    log,
  });
  managerPanel = new ManagerPanelManager({
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

  // -- agent browser panel (Browser Agent UI phase) ---------------------------
  browserProvider = new BrowserViewProvider({
    getBridge: () => bridge,
    ensureBridge,
    log,
  });

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
    managerPanel,
    mcpProvider,
    browserProvider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ManagerViewProvider.viewType, managerProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(McpViewProvider.viewType, mcpProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(BrowserViewProvider.viewType, browserProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('sunday.chat.focus', () => {
      void vscode.commands.executeCommand('sunday.chatView.focus');
    }),
    vscode.commands.registerCommand('sunday.manager.open', () => {
      // P-030 Stage 1: reveal the editor-area panel (create-or-reveal).
      // The sidebar WebviewView stays registered for now (backward compat).
      managerPanel?.reveal();
    }),
    vscode.commands.registerCommand('sunday.manager.openWindow', () => {
      // P-030 Stage 2: reveal the panel, then move it to a dedicated window.
      void managerPanel?.revealInNewWindow();
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
    vscode.commands.registerCommand('sunday.browser.open', () => {
      // Revealing the panel resolves the WebviewView; the panel then drives
      // the browser through the HostBridge `browser/panel/*` methods.
      void vscode.commands.executeCommand('sunday.browserView.focus');
    }),
    vscode.commands.registerCommand('sunday.browser.takeover', async () => {
      // Task 7: plan-gated — don't even attempt the handover (which would
      // start the sidecar) when the plan excludes the browser agent.
      if (!browserAllowedByView(getCachedView(log))) {
        vscode.window.showInformationMessage(`Sunday: ${BROWSER_PLAN_MESSAGE}.`);
        return;
      }
      void vscode.commands.executeCommand('sunday.browserView.focus');
      const b = await getBridgeForCommands();
      if (!b || !browserProvider) return;
      try {
        await browserProvider.takeOver();
        vscode.window.showInformationMessage('You now control the agent browser. Agent browser actions are paused.');
      } catch (err) {
        vscode.window.showErrorMessage(`Take over failed: ${(err as Error).message}`);
      }
    }),
  );

  // -- orchestration commands (parallel agents phase) -------------------------
  registerOrchestrationCommands(context, {
    getBridge: getBridgeForCommands,
    getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    // Prefer the panel (P-030 Stage 1 canonical surface); fall back to the
    // legacy sidebar view so "Stop all" keeps working during the transition.
    getActiveRunId: () => managerPanel?.getActiveRunId() ?? managerProvider?.getActiveRunId(),
    openManagerView: () => {
      managerPanel?.reveal();
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
  // Workflow (Group C) — design-to-code.
  registerDesignToCode(context, { ensureBridge, getCwd: partBCwd, log });
  // Workflow (Group C) — repo onboarding wizard.
  registerOnboardRepo(context, { log });

  // Phase 8 — next-edit suggestions (experimental). Gated by
  // `sunday.nextEdit.enabled` (default false) and fully isolated from the
  // completion pipeline: a bug here cannot break ghost text.
  registerNextEdit(context);

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

  // -- new feature views (F1-F4) -------------------------------------------------
  // Inline adapters read the same files the daemon-side stores use
  // (~/.sunday/memory/memories.jsonl, ~/.sunday/rules.md) without pulling
  // @sunday/skills / @sunday/sundayd into the extension bundle.
  try {
    const sundayDir = path.join(os.homedir(), '.sunday');
    const memoryFile = path.join(sundayDir, 'memory', 'memories.jsonl');
    const rulesFile = path.join(sundayDir, 'rules.md');
    const memoryStore = {
      list: async (opts?: { limit?: number }) => {
        try {
          const raw = await fs.promises.readFile(memoryFile, 'utf8');
          const all = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
          return (opts?.limit ? all.slice(-opts.limit) : all).map((m: any): { id: string; text: string; timestamp: string; project: string; tags: string[]; source: 'auto' | 'manual' } => ({
            id: String(m.id ?? ''),
            text: String(m.text ?? m.content ?? ''),
            timestamp: String(m.timestamp ?? m.createdAt ?? ''),
            project: String(m.project ?? ''),
            tags: Array.isArray(m.tags) ? m.tags.map((t: unknown) => String(t)) : [],
            source: m.source === 'manual' ? 'manual' : 'auto',
          }));
        } catch { return []; }
      },
      delete: async (id: string) => {
        try {
          const raw = await fs.promises.readFile(memoryFile, 'utf8');
          const kept = raw.split('\n').filter((l) => { try { return JSON.parse(l).id !== id; } catch { return true; } });
          await fs.promises.writeFile(memoryFile, kept.join('\n'));
          return true;
        } catch { return false; }
      },
    };
    const ruleStore = {
      list: async () => {
        try {
          const raw = await fs.promises.readFile(rulesFile, 'utf8');
          return raw.split('\n').filter((l) => l.trim().startsWith('- ')).map((l, i) => ({
            id: `rule-${i}`, rule: l.trim().slice(2),
          }));
        } catch { return []; }
      },
      delete: async () => false,
      refresh: async () => {},
    };
    context.subscriptions.push(registerMemoryPanel(context, memoryStore));
    context.subscriptions.push(registerRulesView(context, ruleStore as any));

    // Group B5: cross-project learning — `sunday.memory.applyFrom` lets the
    // user pull memories from another project into the current session.
    // Same JSONL file as the panel adapter above; scoring mirrors
    // MemoryStore.search (token overlap); untagged records count as 'global'.
    const stopWords = new Set(['the','a','an','and','or','to','of','in','on','for','with','by','is','are','was','were','be','it','this','that','we','i','you','at','as','from','will','should','can','has','have','had','do']);
    const tokenize = (text: string): string[] =>
      text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !stopWords.has(t));
    const readMemories = async (): Promise<CrossProjectMemory[]> => {
      try {
        const raw = await fs.promises.readFile(memoryFile, 'utf8');
        return raw.split('\n').filter(Boolean).map((l) => {
          let m: any;
          try { m = JSON.parse(l); } catch { return undefined; }
          if (!m || typeof m.text !== 'string') return undefined;
          return {
            id: String(m.id ?? ''),
            text: String(m.text ?? ''),
            timestamp: String(m.timestamp ?? ''),
            project: String(m.project ?? '') || 'global',
            tags: Array.isArray(m.tags) ? m.tags.map((t: unknown) => String(t)) : [],
            source: m.source === 'manual' ? 'manual' : 'auto',
          } as CrossProjectMemory;
        }).filter((m): m is CrossProjectMemory => m !== undefined);
      } catch { return []; }
    };
    const crossProjectStore: CrossProjectStore = {
      listProjects: async () => [...new Set((await readMemories()).map((m) => m.project))].sort(),
      queryByProject: async (projectId: string, query: string, limit = 10) => {
        const queryTokens = tokenize(query);
        const scored = (await readMemories())
          .filter((m) => m.project === projectId)
          .map((m) => {
            const memTokens = new Set(tokenize(m.text));
            const memTags = m.tags.map((t) => t.toLowerCase());
            let score = 0;
            for (const t of queryTokens) {
              if (memTokens.has(t)) score += 2;
              if (memTags.includes(t)) score += 3;
            }
            return { m, score };
          })
          .filter((s) => s.score > 0 || queryTokens.length === 0)
          .sort((a, b) => b.score - a.score || (b.m.timestamp < a.m.timestamp ? -1 : 1));
        return scored.slice(0, limit).map((s) => s.m);
      },
    };
    const memoryAgentSender = new AgentSender({
      ensureBridge: async () => {
        const b = await getBridgeForCommands();
        if (!b) throw new Error('Sunday sidecar is not running.');
        return b;
      },
      getCwd: () => wsRoot,
      log,
    });
    registerMemoryApplyFrom(context, {
      store: crossProjectStore,
      currentProjectId: () => (wsRoot ? projectIdFor(wsRoot) : undefined),
      sendToAgent: (message: string) => memoryAgentSender.send(message).then(() => undefined),
      log,
    });
  } catch (err) {
    log(`feature views (memory/rules) skipped: ${(err as Error).message}`);
  }
  context.subscriptions.push(registerSwarmWebview(context));
  // Group D2: Sunday Usage dashboard (`sunday.usage.show`).
  context.subscriptions.push(registerUsageCommands(context, { log }));
  // Group D3: end-to-end encrypted session sync (`sunday.sync.upload` /
  // `sunday.sync.download`). Opt-in via `sunday.sync.enabled`.
  for (const d of registerSyncCommands({ context, log })) context.subscriptions.push(d);
  // Group D4: community skills marketplace (`sunday.skills.browse`).
  context.subscriptions.push(registerMarketplaceCommands(context, { log }));
  context.subscriptions.push(registerProactiveMode(context));

  // -- Personalization (Group B): AGENTS.md watcher + style inference -------
  // Group B1: file watcher + `sunday.agentsMd.reload`; the daemon injects
  // AGENTS.md into every session's system prompt (fresh per session).
  registerAgentsMd(context, { getWorkspaceRoot: () => wsRoot, log });
  // Group B2: manual re-run of style inference (`sunday.style.infer`).
  registerStyleInfer(context, { getWorkspaceRoot: () => wsRoot, log });
  // Group B3: new-project wizard (`sunday.initProject`). Templates ship in
  // the vsix under `templates/` (see scripts/package-vsix.mjs).
  registerInitProject(context, {
    templatesDir: path.join(context.extensionPath, 'templates'),
    log,
  });
  // Group B4: agent mode status bar + `sunday.mode.set` (per-workspace
  // persistence; stamped into the sidecar env below).
  registerAgentModes(context, { log });

  // -- Entitlements cache (Task 6) -------------------------------------------
  // Client-side cache for GET /me/entitlements with a 72h grace window (see
  // entitlements/types.ts — the contract Task 7 consumes). UI-only: the
  // gateway re-checks entitlements server-side on every managed request, so a
  // stale or tampered cache can never bypass limits.
  const getSundaySessionForEntitlements = async (): Promise<SundaySessionLike | undefined> => {
    try {
      const ext = vscode.extensions.getExtension<{
        getSundaySession?: () => Promise<SundaySessionLike | undefined>;
      }>(GOOGLE_AUTH_EXTENSION_ID);
      return (await ext?.exports?.getSundaySession?.()) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const entitlements = createEntitlementsCache({
    globalState: context.globalState,
    getSundaySession: getSundaySessionForEntitlements,
    gatewayUrl: process.env.SUNDAY_API_URL?.trim().replace(/\/$/, '') || undefined,
    onUnauthorized: async () => {
      // 401 from /me/entitlements: the Sunday session JWT is dead — clear
      // session state through the auth extension's own sign-out command
      // (best-effort; the SundaySessionManager secret clear runs inside it).
      try {
        await vscode.commands.executeCommand(GOOGLE_SIGN_OUT_COMMAND);
      } catch (err) {
        log(`entitlements: sign-out on 401 failed: ${(err as Error).message}`);
      }
    },
    log,
  });
  // Register the cache as the global entitlements provider so the gated
  // touchpoints (Task 7: model picker, orchestrator caps, browser toggle,
  // index cap) read from it. Without this, all gates fail open by design.
  setEntitlementsProvider(entitlements);

  // -- Sunday Account status bar UI shell (Phase 9.a: minimal, no billing) ---
  context.subscriptions.push(
    registerAccountStatusBar(context, {
      log,
      onSignedIn: () => entitlements.notifySignedIn(),
      onSignedOut: () => entitlements.notifySignedOut(),
    }),
  );

  // -- Engagement: coding streaks (Phase E.1) -----------------------------------
  // Silent streak-day tracking always runs (passive mode: never interrupt a
  // user who is just editing files). Only milestone celebrations (7/14/30d,
  // max 1/day) and the 8 PM at-risk nudge may notify in passive mode; full
  // quest/achievement/XP UI unlocks in active mode (after AI agent use).
  context.subscriptions.push(registerStreakEngagement(context, { log }));

  // -- GitHub: sign-in + one-click repo import ----------------------------------
  // Uses the built-in `github` auth provider (Device Flow); no Sunday-specific
  // OAuth app needed. See githubRepos.ts for the conflict rationale.
  context.subscriptions.push(registerGitHubCommands(context, { log }));

  // -- A1: cloud async tasks ---------------------------------------------------
  // Submit/list commands + 30s completion polling (silent unless enabled).
  registerCloudTaskCommands(context, defaultCloudTaskDeps(log));

  // -- A2: best-of-N parallel attempts -----------------------------------------
  registerBestOfN(context, {
    getBridge: getBridgeForCommands,
    getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    log,
  });

  // -- A3: artifacts panel -----------------------------------------------------
  registerArtifacts(context, { log });

  // -- A5: scheduled tasks -------------------------------------------------------
  registerSchedulerCommands(context, { getBridge: getBridgeForCommands, log });

  // -- A4: mission control -------------------------------------------------------
  // Aggregates orchestrator runs, browser sessions, cloud tasks (A1) and
  // scheduled tasks (A5). Browser sessions are owned by the browser panel
  // webview (no session-list RPC exists), so that section starts empty
  // until a host-queryable session API lands.
  registerMissionControl(context, {
    getBridge: getBridgeForCommands,
    makeCloudTaskClient: defaultCloudTaskDeps(log).makeClient,
    scheduler: makeSchedulerSource({ getBridge: getBridgeForCommands, log }),
    getOrchestrationRunIds: () => {
      const rid = managerPanel?.getActiveRunId() ?? managerProvider?.getActiveRunId();
      return rid ? [rid] : [];
    },
    getBrowserSessions: () => [],
    closeBrowserSession: async () => {
      await vscode.commands.executeCommand('sunday.browserView.focus');
      vscode.window.showInformationMessage('Close the browser session from the Agent Browser panel.');
    },
    log,
  });

  // -- Admin plan toggle (Phase 9.b, Task 8) ----------------------------------
  // Testing-only: set a user's plan on the hosted gateway (x-admin-key from
  // the `sunday.admin.key` setting). Not for production use.
  registerAdminPlanCommand(context, defaultAdminPlanDeps(log));

  // Manual refresh command + delayed startup fetch (fire-and-forget, ~10s so
  // it never slows launch).
  context.subscriptions.push(
    vscode.commands.registerCommand('sunday.account.refreshEntitlements', async () => {
      const { view, source } = await entitlements.refresh();
      const plan = view.plan.charAt(0).toUpperCase() + view.plan.slice(1);
      void vscode.window.showInformationMessage(
        `Sunday entitlements: ${plan} plan (${sourceLabel(source)}).`,
      );
    }),
  );
  const entitlementsTimer = setTimeout(() => void entitlements.getEntitlements(), 10_000);
  // NodeJS.Timeout has unref in the extension host; guard for test envs.
  (entitlementsTimer as unknown as { unref?: () => void }).unref?.();

  // -- Sunday auto-update ------------------------------------------------------
  // Checks the hosted gateway for new IDE releases. Manual via the
  // `sunday.checkForUpdates` command (Help menu); automatic once per
  // session ~30s after startup when `sunday.update.checkOnStartup` is on.
  const SUNDAY_GATEWAY_URL =
    process.env.SUNDAY_API_URL?.trim().replace(/\/$/, '') ||
    'https://sunday-final-ide.onrender.com';
  const updateCfg = vscode.workspace.getConfiguration('sunday.update');
  const updateCheckEnabled = updateCfg.get<boolean>('checkOnStartup', true);

  const makeUpdateService = (): UpdateService => {
    const installer = new UpdateInstaller({
      platform: process.platform,
      downloadFile: async (url, destPath, onProgress) => {
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
        const total = Number(res.headers.get('content-length') ?? 0);
        const file = fs.createWriteStream(destPath);
        try {
          let received = 0;
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (total > 0) onProgress(Math.min(100, Math.round((received / total) * 100)));
            await new Promise<void>((resolve, reject) =>
              file.write(value, (err) => (err ? reject(err) : resolve())),
            );
          }
        } finally {
          await new Promise<void>((resolve) => file.close(() => resolve()));
        }
        const stat = await fs.promises.stat(destPath).catch(() => null);
        if (!stat || stat.size === 0) throw new Error('downloaded file is empty');
      },
      tmpdir: () => os.tmpdir(),
      spawnDetached: (cmd, args) => {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
        child.unref();
      },
      quitIde: () => vscode.commands.executeCommand('workbench.action.quit').then(() => undefined),
      openPath: (target) => vscode.env.openExternal(vscode.Uri.file(target)).then(() => undefined),
      showInfoMessage: (msg, ...items) =>
        vscode.window.showInformationMessage(msg, ...items).then((v) => v),
      showErrorMessage: (msg) => vscode.window.showErrorMessage(msg).then(() => undefined),
      withProgress: (title, task) =>
        vscode.window
          .withProgress(
            { location: vscode.ProgressLocation.Notification, title, cancellable: false },
            (progress) => task((pct) => progress.report({ increment: pct })),
          )
          .then(() => undefined),
      log,
    });
    return new UpdateService({
      fetchJson: async (url) => {
        const res = await fetch(url, { headers: { 'User-Agent': 'sunday-ide' } });
        if (!res.ok) throw new Error(`update check failed (HTTP ${res.status})`);
        return res.json() as Promise<unknown>;
      },
      platform: process.platform,
      currentVersion: version,
      gatewayUrl: SUNDAY_GATEWAY_URL,
      showInfoMessage: (msg, ...items) => vscode.window.showInformationMessage(msg, ...items),
      showErrorMessage: (msg, ...items) => vscode.window.showErrorMessage(msg, ...items),
      openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)).then(() => undefined),
      downloadAndInstall: (info: UpdateInfo) => installer.downloadAndInstall(info),
      log,
    });
  };

  const updateStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  updateStatusBar.command = 'sunday.checkForUpdates';
  context.subscriptions.push(updateStatusBar);

  const runUpdateCheck = async (manual: boolean): Promise<void> => {
    const svc = makeUpdateService();
    if (manual) {
      await svc.checkForUpdates(true);
      return;
    }
    // Auto-check: only surface the status bar affordance, never popups.
    const info = await svc.fetchUpdateInfo();
    if (info?.updateAvailable && info.latest) {
      updateStatusBar.text = `$(arrow-down) Sunday v${info.latest} available`;
      updateStatusBar.tooltip = 'Click to download and install the Sunday update';
      updateStatusBar.show();
    } else {
      updateStatusBar.hide();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sunday.checkForUpdates', () => runUpdateCheck(true)),
  );
  if (updateCheckEnabled) {
    // Delayed so it never slows down launch; once per session.
    const timer = setTimeout(() => void runUpdateCheck(false), 30_000);
    // NodeJS.Timeout has unref in the extension host; guard for test envs.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  // -- smoke-test API ---------------------------------------------------------
  // Minimal hooks for the Electron smoke harness (scripts/smoke/). Not part of
  // the public extension API; used only by automated tests to verify activation,
  // sidecar lifecycle, and the hello handshake without a UI.
  return {
    __sundaySmoke: {
      getSidecarStatus: () => manager.getStatus(),
      getServerInfo: () => manager.getServerInfo(),
      ensureStarted: () => manager.start(),
    },
  };
}

export function deactivate(): void {
  // The SidecarManager is in context.subscriptions; its dispose() stops sundayd.
}
