// sunday-agent — McpViewProvider: the MCP panel (Part A).
//
// A self-contained WebviewView (no ui-* bundle dependency) showing MCP
// servers (name, transport, state, scope), per-server tools, the policy
// approval posture for dangerous tools, last errors, and call history.
// Server lifecycle goes through the HostBridge `mcp/*` methods; dangerous
// tool approvals through `policy/*`. Workspace-trust prompts are injected
// via deps so this stays unit-testable with a mocked `vscode` module.

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';
import type { McpCallRecord, McpServerStatus, McpToolInfo } from '@sunday/protocol';

export const MCP_VIEW_TYPE = 'sunday.mcpView';

export interface McpViewDeps {
  /** Current bridge, if the sidecar is up. */
  getBridge: () => HostBridge | undefined;
  /** Start the sidecar if needed and return the bridge. */
  ensureBridge: () => Promise<HostBridge>;
  log: (msg: string) => void;
  /** Current VS Code workspace-trust verdict. */
  isWorkspaceTrusted: () => boolean;
  /**
   * Prompt Allow/Deny before starting a workspace-scope server in an
   * untrusted workspace. Returns true when the start may proceed.
   */
  confirmWorkspaceServerStart: (serverName: string) => Promise<boolean>;
  /** Prompt to trust the whole workspace, then restart the sidecar. */
  requestTrustWorkspace: () => Promise<void>;
}

interface McpPanelState {
  servers: McpServerStatus[];
  tools: McpToolInfo[];
  calls: McpCallRecord[];
  dangerous: string[];
  approved: string[];
  workspaceTrusted: boolean;
  workspaceConfigIgnored: boolean;
}

export class McpViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = MCP_VIEW_TYPE;

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: McpViewDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = { enableScripts: true };
    webview.html = this.renderHtml(webview);
    void this.refreshState().catch(() => undefined);
    webview.onDidReceiveMessage(
      (msg: unknown) => {
        void this.onMessage(msg);
      },
      undefined,
      this.disposables,
    );
    webviewView.onDidDispose(() => this.disposeView(), undefined, this.disposables);
  }

  /** Re-render when the bridge instance changes (sidecar restart/crash). */
  notifyBridgeChanged(): void {
    if (this.view) void this.refreshState().catch(() => undefined);
  }

  dispose(): void {
    this.disposeView();
  }

  private post(msg: unknown): void {
    if (this.view) {
      void this.view.webview.postMessage(msg);
    }
  }

  private postError(message: string): void {
    this.deps.log(`mcp view: ${message}`);
    this.post({ type: 'sunday/mcp/error', message });
  }

  private async refreshState(): Promise<void> {
    const bridge = this.deps.getBridge();
    if (!bridge) {
      this.postError('Sunday sidecar is not running.');
      return;
    }
    try {
      const [serversRes, toolsRes, callsRes, policyRes] = await Promise.all([
        bridge.mcpServersList(),
        bridge.mcpToolsList(),
        bridge.mcpCallsHistory(50),
        bridge.policyList(),
      ]);
      const state: McpPanelState = {
        servers: serversRes.servers,
        tools: toolsRes.tools,
        calls: callsRes.calls,
        dangerous: policyRes.dangerous,
        approved: policyRes.approved,
        workspaceTrusted: this.deps.isWorkspaceTrusted(),
        workspaceConfigIgnored: serversRes.workspaceConfigIgnored,
      };
      this.post({ type: 'sunday/mcp/state', state });
    } catch (err) {
      this.postError(`refresh failed: ${(err as Error).message}`);
    }
  }

  private async onMessage(msg: unknown): Promise<void> {
    const m = msg as { type?: unknown; name?: unknown; tool?: unknown } & Record<string, unknown>;
    if (!m || typeof m.type !== 'string') return;
    try {
      switch (m.type) {
        case 'sunday/mcp/refresh':
          await this.refreshState();
          break;
        case 'sunday/mcp/start':
          await this.handleStart(typeof m.name === 'string' ? m.name : '');
          break;
        case 'sunday/mcp/stop':
          await this.handleStop(typeof m.name === 'string' ? m.name : '');
          break;
        case 'sunday/mcp/restart':
          await this.handleRestart(typeof m.name === 'string' ? m.name : '');
          break;
        case 'sunday/policy/approve':
          await this.withBridge((b) => b.policyApprove(typeof m.tool === 'string' ? m.tool : ''));
          await this.refreshState();
          break;
        case 'sunday/policy/revoke':
          await this.withBridge((b) => b.policyRevoke(typeof m.tool === 'string' ? m.tool : ''));
          await this.refreshState();
          break;
        case 'sunday/mcp/trust-workspace':
          await this.deps.requestTrustWorkspace();
          break;
        default:
          this.deps.log(`mcp view: ignoring unknown message type "${m.type}"`);
      }
    } catch (err) {
      this.postError(`"${m.type}" failed: ${(err as Error).message}`);
    }
  }

  private async withBridge<T>(fn: (b: HostBridge) => Promise<T>): Promise<T> {
    const bridge = await this.deps.ensureBridge();
    return fn(bridge);
  }

  /** Shared start path: trust prompt for workspace servers in untrusted workspaces. */
  private async startServer(name: string): Promise<void> {
    if (!name) throw new Error('server name is required');
    const bridge = await this.deps.ensureBridge();
    const { servers } = await bridge.mcpServersList();
    const server = servers.find((s) => s.name === name);
    if (server && server.scope === 'workspace' && !this.deps.isWorkspaceTrusted()) {
      const ok = await this.deps.confirmWorkspaceServerStart(name);
      if (!ok) {
        this.deps.log(`mcp view: start of workspace server "${name}" denied by user`);
        return;
      }
    }
    await bridge.mcpServerStart(name);
    this.deps.log(`mcp view: server "${name}" started`);
  }

  private async handleStart(name: string): Promise<void> {
    await this.startServer(name);
    await this.refreshState();
  }

  private async handleStop(name: string): Promise<void> {
    if (!name) throw new Error('server name is required');
    await this.withBridge((b) => b.mcpServerStop(name));
    this.deps.log(`mcp view: server "${name}" stopped`);
    await this.refreshState();
  }

  private async handleRestart(name: string): Promise<void> {
    if (!name) throw new Error('server name is required');
    const bridge = await this.deps.ensureBridge();
    const { servers } = await bridge.mcpServersList();
    const server = servers.find((s) => s.name === name);
    if (server && server.scope === 'workspace' && !this.deps.isWorkspaceTrusted()) {
      const ok = await this.deps.confirmWorkspaceServerStart(name);
      if (!ok) {
        this.deps.log(`mcp view: restart of workspace server "${name}" denied by user`);
        return;
      }
    }
    await bridge.mcpServerRestart(name);
    this.deps.log(`mcp view: server "${name}" restarted`);
    await this.refreshState();
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp =
      `<meta http-equiv="Content-Security-Policy" ` +
      `content="default-src 'none'; script-src 'nonce-${nonce}'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:;">`;
    return `<!DOCTYPE html>
<html><head>${csp}
<style>
body { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); }
h3 { margin: 12px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
.notice { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); padding: 8px; margin-bottom: 8px; }
.row { display: flex; align-items: center; gap: 6px; padding: 6px 4px; border-bottom: 1px solid var(--vscode-widget-border); }
.row .grow { flex: 1; min-width: 0; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
.badge.running { background: var(--vscode-testing-iconPassed); color: #fff; }
.badge.error { background: var(--vscode-testing-iconFailed); color: #fff; }
.badge.stopped { background: var(--vscode-descriptionForeground); color: var(--vscode-editor-background); }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 10px; cursor: pointer; font-size: 11px; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.err { color: var(--vscode-testing-iconFailed); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
.muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
.mono { font-family: var(--vscode-editor-font-family); }
details { margin: 2px 0; }
summary { cursor: pointer; padding: 4px; }
table { width: 100%; border-collapse: collapse; }
td, th { text-align: left; padding: 3px 4px; border-bottom: 1px solid var(--vscode-widget-border); font-size: 11px; vertical-align: top; }
#banner { min-height: 18px; margin-bottom: 4px; }
</style></head>
<body>
<div id="banner"></div>
<div id="trust"></div>
<h3>MCP servers</h3>
<div id="servers"><span class="muted">loading…</span></div>
<h3>Tools</h3>
<div id="tools"><span class="muted">loading…</span></div>
<h3>Call history</h3>
<div id="calls"><span class="muted">loading…</span></div>
<div style="margin-top:10px"><button id="refresh">Refresh</button></div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const post = (type, extra) => vscodeApi.postMessage(Object.assign({ type }, extra || {}));
document.getElementById('refresh').addEventListener('click', () => post('sunday/mcp/refresh'));
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
window.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (m.type === 'sunday/mcp/state') render(m.state);
  else if (m.type === 'sunday/mcp/error') {
    document.getElementById('banner').innerHTML = '<div class="err">' + esc(m.message) + '</div>';
  }
});
function render(st) {
  document.getElementById('banner').innerHTML = '';
  const trust = document.getElementById('trust');
  if (!st.workspaceTrusted) {
    trust.innerHTML = '<div class="notice">Workspace is <b>not trusted</b>. Workspace MCP servers need approval to start; workspace skills with scripts are disabled.' +
      (st.workspaceConfigIgnored ? ' The workspace <span class="mono">.sunday/mcp.json</span> is currently ignored.' : '') +
      ' <button class="primary" id="trustBtn">Trust workspace…</button></div>';
    document.getElementById('trustBtn').addEventListener('click', () => post('sunday/mcp/trust-workspace'));
  } else { trust.innerHTML = ''; }

  const serversEl = document.getElementById('servers');
  if (!st.servers.length) { serversEl.innerHTML = '<span class="muted">no MCP servers configured</span>'; }
  else {
    serversEl.innerHTML = st.servers.map((s) =>
      '<div class="row"><div class="grow"><span class="mono">' + esc(s.name) + '</span> ' +
      '<span class="badge">' + esc(s.transport) + '</span> ' +
      '<span class="badge">' + esc(s.scope) + '</span> ' +
      '<span class="badge ' + esc(s.state) + '">' + esc(s.state) + '</span> ' +
      '<span class="muted">' + s.toolCount + ' tools</span>' +
      (s.lastError ? '<div class="err">' + esc(s.lastError) + '</div>' : '') +
      '</div>' +
      '<button data-act="start" data-name="' + esc(s.name) + '">Start</button>' +
      '<button data-act="restart" data-name="' + esc(s.name) + '">Restart</button>' +
      '<button data-act="stop" data-name="' + esc(s.name) + '">Stop</button></div>'
    ).join('');
  }

  const toolsEl = document.getElementById('tools');
  const byServer = {};
  st.tools.forEach((t) => { (byServer[t.server] = byServer[t.server] || []).push(t); });
  const names = Object.keys(byServer).sort();
  toolsEl.innerHTML = names.length ? names.map((srv) =>
    '<details><summary><span class="mono">' + esc(srv) + '</span> <span class="muted">(' + byServer[srv].length + ')</span></summary>' +
    '<table>' + byServer[srv].map((t) => {
      const dangerous = st.dangerous.includes(t.namespaced);
      const approved = st.approved.includes(t.namespaced);
      const action = dangerous && !approved
        ? '<button data-policy="approve" data-tool="' + esc(t.namespaced) + '">Approve</button>'
        : (dangerous ? '<button data-policy="revoke" data-tool="' + esc(t.namespaced) + '">Revoke</button>' : '');
      return '<tr><td class="mono">' + esc(t.namespaced) + '</td><td>' + esc(t.description || '') +
        (t.enabled ? '' : ' <span class="badge">disabled</span>') +
        (dangerous ? ' <span class="badge">dangerous</span>' : '') +
        (approved ? ' <span class="badge">approved</span>' : '') +
        '</td><td>' + action + '</td></tr>';
    }).join('') + '</table></details>'
  ).join('') : '<span class="muted">no tools — start a server</span>';

  const callsEl = document.getElementById('calls');
  const calls = (st.calls || []).slice().reverse().slice(0, 20);
  callsEl.innerHTML = calls.length ? '<table>' + calls.map((c) =>
    '<tr><td class="muted">' + esc(c.at) + '</td><td class="mono">' + esc(c.namespaced) + '</td>' +
    '<td>' + (c.ok ? '<span class="badge running">ok</span>' : '<span class="badge error">error</span>') + '</td>' +
    '<td class="muted">' + c.durationMs + 'ms</td></tr>' +
    (c.ok ? '' : '<tr><td></td><td colspan="3" class="err">' + esc(c.error || '') + '</td></tr>')
  ).join('') + '</table>' : '<span class="muted">no calls yet</span>';

  serversEl.querySelectorAll('button[data-act]').forEach((b) =>
    b.addEventListener('click', () => post('sunday/mcp/' + b.getAttribute('data-act'), { name: b.getAttribute('data-name') })));
  toolsEl.querySelectorAll('button[data-policy]').forEach((b) =>
    b.addEventListener('click', () => post('sunday/policy/' + b.getAttribute('data-policy'), { tool: b.getAttribute('data-tool') })));
}
post('sunday/mcp/refresh');
</script>
</body></html>`;
  }

  private disposeView(): void {
    this.view = undefined;
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}
