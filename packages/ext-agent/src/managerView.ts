// sunday-agent — ManagerViewProvider: hosts the @sunday/ui-manager webview.
//
// Serves the built ui-manager bundle (dist/index.html) inside a VS Code
// WebviewView, routes webview messages to the HostBridge/sundayd sidecar
// (session list, chat/cancel, checkpoint/*, worktree/*), and pushes state
// snapshots back. vscode-coupled by design; covered by managerView.test.ts
// with a mocked `vscode` module. Mirrors chatView.ts.
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';
import type { ChatEventNotification } from '@sunday/protocol';

export const MANAGER_VIEW_TYPE = 'sunday.managerView';

export interface ManagerViewDeps {
  /** context.extensionPath of the sunday-agent extension. */
  extensionPath: string;
  /** Current bridge, if the sidecar is up. */
  getBridge: () => HostBridge | undefined;
  /** Start the sidecar if needed and return the bridge. */
  ensureBridge: () => Promise<HostBridge>;
  /** cwd for manager operations (first workspace folder). */
  getCwd: () => string | undefined;
  log: (msg: string) => void;
}

/**
 * Locate the built ui-manager bundle. Dev checkout first
 * (`<extensionDir>/../ui-manager/dist`), then the packaged layout
 * (`<extensionDir>/ui-manager/dist`). The first candidate containing
 * `index.html` wins; otherwise a clear, actionable error.
 */
export function resolveManagerDistDir(extensionPath: string): string {
  const candidates = [
    path.join(extensionPath, '..', 'ui-manager', 'dist'),
    path.join(extensionPath, 'ui-manager', 'dist'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'index.html')).isFile()) return dir;
    } catch {
      /* not here — try the next candidate */
    }
  }
  throw new Error(
    'Sunday manager UI not found. Looked for index.html in:\n' +
      candidates.map((c) => `  - ${c}`).join('\n') +
      '\nBuild @sunday/ui-manager first: pnpm --filter @sunday/ui-manager build.',
  );
}

export class ManagerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = MANAGER_VIEW_TYPE;

  private view: vscode.WebviewView | undefined;
  private detachBridge: (() => void) | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** sessionId → turnId for turns currently streaming (from chat events). */
  private readonly activeTurns = new Map<string, string>();

  constructor(private readonly deps: ManagerViewDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.distDir())],
    };
    webview.html = this.renderHtml(webview);
    this.attachBridge();
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

  /** Re-subscribe when the bridge instance changes (sidecar restart/crash). */
  notifyBridgeChanged(): void {
    if (this.view) this.attachBridge();
  }

  dispose(): void {
    this.disposeView();
  }

  private distDir(): string {
    return resolveManagerDistDir(this.deps.extensionPath);
  }

  private attachBridge(): void {
    this.detachBridge?.();
    this.detachBridge = undefined;
    const bridge = this.deps.getBridge();
    if (!bridge) return;
    this.detachBridge = bridge.onChatEvent((n) => this.trackTurn(n));
  }

  /** Track per-session active turns from daemon chat events. */
  private trackTurn(n: ChatEventNotification): void {
    if (n.event.type === 'turn-end' || n.event.type === 'turn-error') {
      if (this.activeTurns.get(n.sessionId) === n.turnId) this.activeTurns.delete(n.sessionId);
    } else {
      this.activeTurns.set(n.sessionId, n.turnId);
    }
  }

  private post(msg: unknown): void {
    if (this.view) {
      void this.view.webview.postMessage(msg);
    }
  }

  private postError(message: string): void {
    this.deps.log(`manager view: ${message}`);
    this.post({ type: 'sunday/manager/error', message });
  }

  /** Push a full state snapshot to the webview. */
  private async refreshState(): Promise<void> {
    const bridge = this.deps.getBridge();
    if (!bridge) {
      this.postError('Sunday sidecar is not running.');
      return;
    }
    const workspaceRoot = this.deps.getCwd();
    try {
      const [{ sessions }, checkpoints, worktrees] = await Promise.all([
        bridge.sessionList(),
        workspaceRoot ? bridge.checkpointList({ workspaceRoot }) : { checkpoints: [] },
        workspaceRoot ? bridge.worktreeList({ repoRoot: workspaceRoot }) : { worktrees: [] },
      ]);
      this.post({
        type: 'sunday/manager/state',
        workspaceRoot,
        repoRoot: workspaceRoot,
        agents: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          model: s.model,
          updatedAt: s.updatedAt,
          activeTurn: this.activeTurns.get(s.id),
        })),
        checkpoints: checkpoints.checkpoints,
        worktrees: worktrees.worktrees,
      });
    } catch (err) {
      this.postError(`refresh failed: ${(err as Error).message}`);
    }
  }

  private async onMessage(msg: unknown): Promise<void> {
    const m = msg as { type?: unknown } & Record<string, unknown>;
    if (!m || typeof m.type !== 'string') return;
    try {
      switch (m.type) {
        case 'sunday/manager/refresh':
          await this.refreshState();
          break;
        case 'sunday/manager/stop-turn':
          await this.handleStopTurn(typeof m.turnId === 'string' ? m.turnId : '');
          break;
        case 'sunday/checkpoint/create':
          await this.handleCheckpointCreate(typeof m.label === 'string' ? m.label : undefined);
          break;
        case 'sunday/checkpoint/restore':
          await this.handleCheckpointRestore(typeof m.id === 'string' ? m.id : '');
          break;
        case 'sunday/worktree/add':
          await this.handleWorktreeAdd(
            typeof m.branch === 'string' ? m.branch : '',
            typeof m.path === 'string' ? m.path : undefined,
          );
          break;
        case 'sunday/worktree/remove':
          await this.handleWorktreeRemove(
            typeof m.path === 'string' ? m.path : '',
            m.force === true,
          );
          break;
        case 'sunday/worktree/merge':
          await this.handleWorktreeMerge(
            typeof m.path === 'string' ? m.path : '',
            typeof m.target === 'string' ? m.target : undefined,
          );
          break;
        default:
          this.deps.log(`manager view: ignoring unknown message type "${m.type}"`);
      }
    } catch (err) {
      this.postError(`"${m.type}" failed: ${(err as Error).message}`);
    }
  }

  private async withBridge<T>(fn: (b: HostBridge) => Promise<T>): Promise<T> {
    const bridge = await this.deps.ensureBridge();
    return fn(bridge);
  }

  private requireRoot(): string {
    const root = this.deps.getCwd();
    if (!root) throw new Error('no workspace folder open');
    return root;
  }

  private async handleStopTurn(turnId: string): Promise<void> {
    if (!turnId) return;
    await this.withBridge((b) => b.chatCancel(turnId));
    await this.refreshState();
  }

  private async handleCheckpointCreate(label: string | undefined): Promise<void> {
    const workspaceRoot = this.requireRoot();
    const res = await this.withBridge((b) =>
      b.checkpointCreate(label ? { workspaceRoot, label } : { workspaceRoot }),
    );
    this.deps.log(`manager view: checkpoint created ${res.sha}`);
    await this.refreshState();
  }

  private async handleCheckpointRestore(id: string): Promise<void> {
    if (!id) throw new Error('checkpoint id is required');
    const workspaceRoot = this.requireRoot();
    const res = await this.withBridge((b) => b.checkpointRestore({ workspaceRoot, id }));
    this.deps.log(`manager view: restored checkpoint ${res.sha} (${res.filesRestored} files)`);
    await this.refreshState();
  }

  private async handleWorktreeAdd(branch: string, wtPath: string | undefined): Promise<void> {
    if (!branch.trim()) throw new Error('branch name is required');
    const repoRoot = this.requireRoot();
    const res = await this.withBridge((b) =>
      b.worktreeAdd(wtPath ? { repoRoot, branch, path: wtPath } : { repoRoot, branch }),
    );
    this.deps.log(`manager view: worktree added at ${res.path} (${res.branch})`);
    await this.refreshState();
  }

  private async handleWorktreeRemove(wtPath: string, force: boolean): Promise<void> {
    if (!wtPath) throw new Error('worktree path is required');
    const repoRoot = this.requireRoot();
    await this.withBridge((b) => b.worktreeRemove({ repoRoot, path: wtPath, force }));
    this.deps.log(`manager view: worktree removed ${wtPath}`);
    await this.refreshState();
  }

  private async handleWorktreeMerge(wtPath: string, target: string | undefined): Promise<void> {
    if (!wtPath) throw new Error('worktree path is required');
    const repoRoot = this.requireRoot();
    const res = await this.withBridge((b) =>
      b.worktreeMerge(target ? { repoRoot, path: wtPath, target } : { repoRoot, path: wtPath }),
    );
    this.deps.log(`manager view: merged into ${res.target} (${res.sha})`);
    await this.refreshState();
  }

  /**
   * Build the webview HTML: rewrite the vite bundle's relative asset URLs to
   * webview URIs, nonce every script, and install a strict CSP.
   */
  private renderHtml(webview: vscode.Webview): string {
    const distDir = this.distDir();
    const distUri = webview.asWebviewUri(vscode.Uri.file(distDir));
    const nonce = crypto.randomBytes(16).toString('hex');
    let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    html = html.replace(/(src|href)="\.\//g, `$1="${distUri}/`);
    html = html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
    const csp =
      `<meta http-equiv="Content-Security-Policy" ` +
      `content="default-src 'none'; script-src 'nonce-${nonce}'; ` +
      `style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">`;
    html = html.includes('<head>') ? html.replace('<head>', `<head>\n${csp}`) : `${csp}\n${html}`;
    return html;
  }

  private disposeView(): void {
    this.detachBridge?.();
    this.detachBridge = undefined;
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
