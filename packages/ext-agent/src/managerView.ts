// sunday-agent — Agent Manager webview host.
//
// Serves the built ui-manager bundle (dist/index.html), routes webview
// messages to the HostBridge/sundayd sidecar (session list, chat/cancel,
// checkpoint/*, worktree/*, orchestration), and pushes state snapshots
// back. vscode-coupled by design; covered by managerView.test.ts with a
// mocked `vscode` module. Mirrors chatView.ts.
//
// P-030 Stage 1: the shared logic lives in ManagerWebviewController, which
// works against any vscode.Webview. ManagerViewProvider (sidebar
// WebviewView, view type `sunday.managerView`) is the legacy host and stays
// registered for now; ManagerPanelManager (editor-area WebviewPanel, panel
// type `sunday.managerPanel`) is the design-doc §20.2 surface and is what
// `sunday.manager.open` reveals.
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';
import type {
  ChatEventNotification,
  MergeConflict,
  OrchestrationEvent,
  OrchestrationPhase,
  OrchestrationRunState,
  RunStatus,
  UnitRunStatus,
} from '@sunday/protocol';

export const MANAGER_VIEW_TYPE = 'sunday.managerView';
/** Editor-area panel type for the Agent Manager (P-030 Stage 1). */
export const MANAGER_PANEL_TYPE = 'sunday.managerPanel';

/** Webview → extension: resolve one merge conflict in favour of a unit. */
export const ORCHESTRATION_RESOLVE_MESSAGE = 'sunday/orchestration/resolve';
/** Webview → extension: open a vscode.diff for a conflict's two worktree files. */
export const ORCHESTRATION_OPEN_DIFF_MESSAGE = 'sunday/orchestration/openDiff';
/** Webview → extension: stop the active orchestration run (confirmed). */
export const ORCHESTRATION_STOP_ALL_MESSAGE = 'sunday/orchestration/stopAll';
/** Extension → webview: orchestration runs snapshot. */
export const ORCHESTRATION_STATE_MESSAGE = 'sunday/manager/orchestration';

/** Cap on log lines kept per unit (accumulated from orchestrate/event details). */
export const MAX_UNIT_LOG_LINES = 100;

/** One unit of an orchestration run, as shown in the manager webview. */
export interface UnitRunView {
  id: string;
  title: string;
  status: UnitRunStatus;
  worktreePath?: string;
  model?: string;
  steps?: number;
  sha?: string;
  error?: string;
  /** Recent log lines accumulated from orchestrate/event details (newest last). */
  log: string[];
}

/** One orchestration run, as shown in the manager webview. */
export interface OrchestrationRunView {
  runId: string;
  goal: string;
  parallel: boolean;
  status: RunStatus;
  units: UnitRunView[];
  conflicts: MergeConflict[];
  updatedAt: string;
}

/** Map an orchestrate/event phase onto a unit status. Run-level phases
 *  ('planned' with no unit, 'conflicted') return undefined. */
export function eventPhaseToUnitStatus(phase: OrchestrationPhase): UnitRunStatus | undefined {
  switch (phase) {
    case 'queued':
    case 'planned':
      return 'queued';
    case 'started':
      return 'running';
    case 'verifying':
      return 'verifying';
    case 'merged':
      return 'done';
    case 'failed':
      return 'failed';
    case 'conflicted':
      return undefined;
  }
}

const TERMINAL_UNIT_STATUSES: readonly UnitRunStatus[] = ['done', 'failed', 'cancelled'];
const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['done', 'failed', 'cancelled', 'interrupted'];

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

/**
 * Shared Agent Manager webview controller. Owns the ui-manager HTML,
 * the webview↔HostBridge message protocol, orchestration run tracking,
 * and bridge (re)subscription. Works against any vscode.Webview, so both
 * the sidebar WebviewView and the editor-area WebviewPanel build on it
 * without duplicating logic.
 */
export class ManagerWebviewController {
  protected readonly disposables: vscode.Disposable[] = [];
  private webview: vscode.Webview | undefined;
  private detachBridge: (() => void) | undefined;
  private detachOrchestrate: (() => void) | undefined;
  /** sessionId → turnId for turns currently streaming (from chat events). */
  private readonly activeTurns = new Map<string, string>();
  /** runId → latest known run view (from orchestrate/event + orchestrate/status). */
  private readonly runs = new Map<string, OrchestrationRunView>();
  /** Serializes orchestrate/event handling so before/after snapshots stay consistent. */
  private orchestrateQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ManagerViewDeps) {}

  /**
   * Bind this controller to a webview: set webview options, serve the
   * ui-manager HTML, subscribe to the bridge, push the initial state,
   * and route incoming messages. Shared by the sidebar view and the
   * editor-area panel.
   */
  protected attachWebview(webview: vscode.Webview): void {
    this.webview = webview;
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
  }

  /** Detach from the webview: drop bridge subscriptions and disposables. */
  protected detachWebview(): void {
    this.detachBridge?.();
    this.detachBridge = undefined;
    this.detachOrchestrate?.();
    this.detachOrchestrate = undefined;
    this.webview = undefined;
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  /** Re-subscribe when the bridge instance changes (sidecar restart/crash). */
  notifyBridgeChanged(): void {
    if (this.webview) this.attachBridge();
  }

  dispose(): void {
    this.detachWebview();
  }

  protected distDir(): string {
    return resolveManagerDistDir(this.deps.extensionPath);
  }

  protected attachBridge(): void {
    this.detachBridge?.();
    this.detachBridge = undefined;
    this.detachOrchestrate?.();
    this.detachOrchestrate = undefined;
    const bridge = this.deps.getBridge();
    if (!bridge) return;
    this.detachBridge = bridge.onChatEvent((n) => this.trackTurn(n));
    // Serialize: events must be applied in arrival order for the
    // before/after transition diffing in handleOrchestrateEvent.
    this.detachOrchestrate = bridge.onOrchestrateEvent((n) => {
      this.orchestrateQueue = this.orchestrateQueue
        .then(() => this.handleOrchestrateEvent(n))
        .catch(() => undefined);
    });
  }

  /** Track per-session active turns from daemon chat events. */
  private trackTurn(n: ChatEventNotification): void {
    if (n.event.type === 'turn-end' || n.event.type === 'turn-error') {
      if (this.activeTurns.get(n.sessionId) === n.turnId) this.activeTurns.delete(n.sessionId);
    } else {
      this.activeTurns.set(n.sessionId, n.turnId);
    }
  }

  // -- orchestration (parallel agents) -----------------------------------------

  /**
   * Run id of the latest run that is still actionable (running/conflicted),
   * or undefined when nothing is active. Used by "Stop all".
   */
  getActiveRunId(): string | undefined {
    let active: string | undefined;
    for (const [runId, run] of this.runs) {
      if (run.status === 'running' || run.status === 'conflicted') active = runId;
    }
    return active;
  }

  /** Live updates for the orchestration section: refresh from
   *  orchestrate/status on every event, falling back to a local projection
   *  from the event stream when the daemon does not implement it. */
  private async handleOrchestrateEvent(n: OrchestrationEvent): Promise<void> {
    // Snapshot: the fallback path mutates the stored view in place, so the
    // transition diff needs a deep copy of the pre-event state.
    const before = this.runs.get(n.runId);
    const beforeSnap = before ? structuredClone(before) : undefined;
    let state: OrchestrationRunState | undefined;
    try {
      const bridge = await this.deps.ensureBridge();
      state = await bridge.orchestrateStatus(n.runId);
    } catch (err) {
      this.deps.log(`manager view: orchestrate/status failed: ${(err as Error).message}`);
    }
    if (state) this.setRunFromState(state, n);
    else this.applyEventFallback(n);
    this.notifyRunChanges(beforeSnap, this.runs.get(n.runId));
    this.postOrchestration();
  }

  /** Merge an authoritative run state with event detail lines (unit logs). */
  private setRunFromState(state: OrchestrationRunState, event?: OrchestrationEvent): void {
    const prev = this.runs.get(state.runId);
    const units: UnitRunView[] = state.units.map((u) => {
      const prevUnit = prev?.units.find((p) => p.id === u.id);
      let log = prevUnit?.log ?? [];
      if (event && event.unitId === u.id && event.detail && event.phase !== 'conflicted') {
        const lines = event.detail.split('\n').map((l) => l.trim()).filter(Boolean);
        log = [...log, ...lines].slice(-MAX_UNIT_LOG_LINES);
      }
      return { ...u, log };
    });
    this.runs.set(state.runId, {
      runId: state.runId,
      goal: state.goal,
      parallel: state.parallel,
      status: state.status,
      units,
      conflicts: state.conflicts,
      updatedAt: state.updatedAt,
    });
  }

  /** Best-effort local projection when orchestrate/status is unavailable. */
  private applyEventFallback(n: OrchestrationEvent): void {
    let view = this.runs.get(n.runId);
    if (!view) {
      view = {
        runId: n.runId,
        goal: '',
        parallel: false,
        status: 'running',
        units: [],
        conflicts: [],
        updatedAt: new Date().toISOString(),
      };
      this.runs.set(n.runId, view);
    }
    if (n.phase === 'conflicted') {
      view.status = 'conflicted';
      try {
        const parsed: unknown = JSON.parse(n.detail ?? 'null');
        if (Array.isArray(parsed)) view.conflicts = parsed as MergeConflict[];
      } catch {
        /* detail is informational only — ignore unparseable JSON */
      }
    } else if (n.unitId) {
      let unit = view.units.find((u) => u.id === n.unitId);
      if (!unit) {
        unit = { id: n.unitId, title: n.unitId, status: 'queued', log: [] };
        view.units.push(unit);
      }
      const mapped = eventPhaseToUnitStatus(n.phase);
      if (mapped) unit.status = mapped;
      if (n.detail) {
        const lines = n.detail.split('\n').map((l) => l.trim()).filter(Boolean);
        unit.log = [...unit.log, ...lines].slice(-MAX_UNIT_LOG_LINES);
      }
      if (view.status !== 'conflicted' && view.units.length > 0) {
        const allTerminal = view.units.every((u) => TERMINAL_UNIT_STATUSES.includes(u.status));
        view.status = allTerminal
          ? view.units.every((u) => u.status === 'done')
            ? 'done'
            : 'failed'
          : 'running';
      }
    }
    view.updatedAt = new Date().toISOString();
  }

  /** Toasts on unit/run transitions. Only fires on actual transitions —
   *  subscribing mid-run never replays history as notifications. */
  private notifyRunChanges(
    before: OrchestrationRunView | undefined,
    after: OrchestrationRunView | undefined,
  ): void {
    if (!before || !after) return;
    for (const unit of after.units) {
      const prev = before.units.find((u) => u.id === unit.id);
      if (!prev || prev.status === unit.status) continue;
      const label = unit.title || unit.id;
      if (unit.status === 'done') {
        vscode.window.showInformationMessage(`Sunday: unit "${label}" done.`);
      } else if (unit.status === 'failed') {
        vscode.window.showInformationMessage(
          `Sunday: unit "${label}" failed${unit.error ? ` — ${unit.error}` : '.'}`,
        );
      } else if (unit.status === 'cancelled') {
        vscode.window.showInformationMessage(`Sunday: unit "${label}" cancelled.`);
      }
    }
    if (before.status === after.status || TERMINAL_RUN_STATUSES.includes(before.status)) return;
    if (after.status === 'done') {
      const merged = after.units.filter((u) => u.status === 'done').length;
      vscode.window.showInformationMessage(
        `Sunday: orchestration run finished — ${merged}/${after.units.length} units done.`,
      );
    } else if (after.status === 'conflicted') {
      vscode.window.showInformationMessage(
        'Sunday: orchestration run has merge conflicts — review them in the Manager.',
      );
    } else if (after.status === 'failed') {
      vscode.window.showInformationMessage('Sunday: orchestration run failed.');
    } else if (after.status === 'cancelled') {
      vscode.window.showInformationMessage('Sunday: orchestration run cancelled.');
    }
  }

  private postOrchestration(): void {
    this.post({ type: ORCHESTRATION_STATE_MESSAGE, runs: [...this.runs.values()] });
  }

  /** Re-read one run from orchestrate/status and re-post (after stop/resolve). */
  private async refreshOrchestrationRun(runId: string): Promise<void> {
    const before = this.runs.get(runId);
    try {
      const state = await this.withBridge((b) => b.orchestrateStatus(runId));
      this.setRunFromState(state);
      this.notifyRunChanges(before, this.runs.get(runId));
    } catch (err) {
      this.postError(`orchestration refresh failed: ${(err as Error).message}`);
    }
    this.postOrchestration();
  }

  private async handleOrchestrationStopAll(): Promise<void> {
    const runId = this.getActiveRunId();
    if (!runId) {
      this.postError('No active orchestration run.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Stop all units of orchestration run "${runId}"?`,
      'Stop all',
      'Cancel',
    );
    if (choice !== 'Stop all') return;
    const res = await this.withBridge((b) => b.orchestrateStop(runId));
    this.deps.log(`manager view: stopAll ${runId} → stopped=${res.stopped}`);
    await this.refreshOrchestrationRun(runId);
  }

  private async handleResolveConflict(
    runId: string,
    conflictIndex: number,
    keepUnitId: string,
  ): Promise<void> {
    if (!runId) throw new Error('runId is required');
    if (!Number.isInteger(conflictIndex) || conflictIndex < 0) {
      throw new Error('conflictIndex must be a non-negative integer');
    }
    if (!keepUnitId) throw new Error('keepUnitId is required');
    const res = await this.withBridge((b) =>
      b.orchestrateResolveConflict(runId, [{ conflictIndex, keepUnitId }]),
    );
    this.deps.log(
      `manager view: resolved conflict ${conflictIndex} in ${runId} (keep ${keepUnitId}); ` +
        `${res.conflicts.length} conflict(s) remaining, ${res.merged.length} merged`,
    );
    await this.refreshOrchestrationRun(runId);
  }

  private async handleOpenDiff(runId: string, conflictIndex: number): Promise<void> {
    const run = this.runs.get(runId);
    const conflict = run?.conflicts.find((c) => c.index === conflictIndex);
    if (!conflict) throw new Error(`conflict ${conflictIndex} not found in run ${runId || '(unknown)'}`);
    const hunk = conflict.hunks[0];
    if (!hunk) throw new Error(`conflict ${conflictIndex} has no hunks`);
    const wtA = run!.units.find((u) => u.id === hunk.unitA)?.worktreePath;
    const wtB = run!.units.find((u) => u.id === hunk.unitB)?.worktreePath;
    if (!wtA || !wtB) {
      throw new Error(`worktree path missing for conflict units ${hunk.unitA}/${hunk.unitB}`);
    }
    const uriA = vscode.Uri.file(path.join(wtA, hunk.file));
    const uriB = vscode.Uri.file(path.join(wtB, hunk.file));
    await vscode.commands.executeCommand(
      'vscode.diff',
      uriA,
      uriB,
      `Sunday conflict: ${hunk.unitA} ↔ ${hunk.unitB} — ${hunk.file}`,
    );
  }

  private post(msg: unknown): void {
    if (this.webview) {
      void this.webview.postMessage(msg);
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
      this.postOrchestration();
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
        case ORCHESTRATION_STOP_ALL_MESSAGE:
          await this.handleOrchestrationStopAll();
          break;
        case ORCHESTRATION_RESOLVE_MESSAGE:
          await this.handleResolveConflict(
            typeof m.runId === 'string' ? m.runId : '',
            typeof m.conflictIndex === 'number' ? m.conflictIndex : NaN,
            typeof m.keepUnitId === 'string' ? m.keepUnitId : '',
          );
          break;
        case ORCHESTRATION_OPEN_DIFF_MESSAGE:
          await this.handleOpenDiff(
            typeof m.runId === 'string' ? m.runId : '',
            typeof m.conflictIndex === 'number' ? m.conflictIndex : NaN,
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
}

/**
 * Legacy host: the Agent Manager as an Explorer-sidebar WebviewView
 * (view type `sunday.managerView`). Kept registered for now; P-030 Stage 1
 * moves the canonical surface to ManagerPanelManager below.
 */
export class ManagerViewProvider extends ManagerWebviewController implements vscode.WebviewViewProvider {
  public static readonly viewType = MANAGER_VIEW_TYPE;

  private view: vscode.WebviewView | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.attachWebview(webviewView.webview);
    webviewView.onDidDispose(
      () => {
        this.view = undefined;
        this.detachWebview();
      },
      undefined,
      this.disposables,
    );
  }

  dispose(): void {
    this.view = undefined;
    this.detachWebview();
  }
}

/**
 * P-030 Stage 1: the Agent Manager as an editor-area WebviewPanel
 * (panel type `sunday.managerPanel`), matching design doc §20.2. Shares
 * all HTML serving and message routing with the sidebar view via
 * ManagerWebviewController — the ui-manager bundle and protocol are
 * unchanged.
 */
export class ManagerPanelManager extends ManagerWebviewController {
  public static readonly panelType = MANAGER_PANEL_TYPE;

  private panel: vscode.WebviewPanel | undefined;

  /** Create-or-reveal: focus the existing panel, or create it on first use. */
  reveal(): void {
    const existing = this.panel;
    if (existing) {
      existing.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      MANAGER_PANEL_TYPE,
      'Sunday Manager',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    this.panel = panel;
    this.attachWebview(panel.webview);
    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.detachWebview();
      },
      undefined,
      this.disposables,
    );
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.detachWebview();
  }
}
