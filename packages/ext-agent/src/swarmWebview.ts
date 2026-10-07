// sunday-agent — SwarmViewProvider: the "One-Prompt Swarm" mission-control
// board (F3).
//
// A self-contained WebviewView that renders a Kanban board with four
// columns — Queued / Running / Review / Merged — plus a Failed section for
// units that errored. The board state is driven by `SwarmEvent`s pushed from
// the host (via `pushSwarmEvent`); the webview itself keeps a local
// in-memory model so the board renders instantly and stays in sync.
//
// The pure state reducer (`applySwarmEvent`) is vscode-free and unit-tested
// in swarmWebview.test.ts. The webview HTML is fully self-contained
// (inline CSS/JS, no CDN).

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

export const SWARM_VIEW_TYPE = 'sunday.swarmView';

export type SwarmUnitStatus = 'queued' | 'running' | 'review' | 'merged' | 'failed';

/** One status transition for a swarm unit, fed to the board by the host. */
export interface SwarmEvent {
  unitId: string;
  title: string;
  status: SwarmUnitStatus;
  detail?: string;
}

/** A unit as rendered on the board. */
export interface SwarmUnit {
  unitId: string;
  title: string;
  status: SwarmUnitStatus;
  detail?: string;
  updatedAt: number;
}

export interface SwarmState {
  units: SwarmUnit[];
}

/** Empty board state. */
export function emptySwarmState(): SwarmState {
  return { units: [] };
}

/**
 * Pure state reducer: fold one `SwarmEvent` into the board state and return
 * a NEW state (the input is never mutated). An event for an unknown unit
 * creates its entry.
 */
export function applySwarmEvent(state: SwarmState, evt: SwarmEvent): SwarmState {
  const updated: SwarmUnit = {
    unitId: evt.unitId,
    title: evt.title,
    status: evt.status,
    detail: evt.detail,
    updatedAt: Date.now(),
  };
  if (!state.units.some((u) => u.unitId === evt.unitId)) {
    return { units: [...state.units, updated] };
  }
  return {
    units: state.units.map((u) => (u.unitId === evt.unitId ? updated : u)),
  };
}

/** Kanban column keys in board order. */
export const SWARM_COLUMNS: Array<{ key: 'queued' | 'running' | 'review' | 'merged'; label: string }> = [
  { key: 'queued', label: 'Queued' },
  { key: 'running', label: 'Running' },
  { key: 'review', label: 'Review' },
  { key: 'merged', label: 'Merged' },
];

export interface SwarmWebviewDeps {
  /** Injected: called when the user hits "Stop all" in the board header. */
  onStopAll: () => void;
  log?: (msg: string) => void;
}

export class SwarmViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = SWARM_VIEW_TYPE;

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: SwarmWebviewDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = { enableScripts: true };
    webview.html = this.renderHtml(webview);
    webview.onDidReceiveMessage(
      (msg: unknown) => {
        void this.onMessage(msg);
      },
      undefined,
      this.disposables,
    );
    webviewView.onDidDispose(() => this.disposeView(), undefined, this.disposables);
  }

  /** Feed a swarm event into the board (host side; pushes to the webview). */
  pushSwarmEvent(evt: SwarmEvent): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: 'sunday/swarm/event', event: evt });
    }
  }

  dispose(): void {
    this.disposeView();
  }

  private disposeView(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    this.view = undefined;
  }

  private onMessage(msg: unknown): void {
    const m = msg as { command?: unknown } & Record<string, unknown>;
    if (!m || typeof m.command !== 'string') return;
    if (m.command === 'stopAll') {
      this.deps.log?.('swarm view: user hit "Stop all"');
      this.deps.onStopAll();
    } else {
      this.deps.log?.(`swarm view: ignoring unknown command ${m.command}`);
    }
  }

  // -- html ----------------------------------------------------------------------

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
#header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
#header h2 { font-size: 13px; margin: 0; flex: 1; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  border: none; padding: 4px 10px; cursor: pointer; font-size: 11px; white-space: nowrap; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.danger { background: var(--vscode-testing-iconFailed); color: #fff; }
button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
#board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.col { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border);
  border-radius: 4px; min-height: 120px; display: flex; flex-direction: column; }
.col h3 { margin: 0; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border);
  display: flex; justify-content: space-between; align-items: center; }
.count { font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  border-radius: 8px; padding: 0 6px; }
.cards { padding: 6px; display: flex; flex-direction: column; gap: 6px; }
.card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border);
  border-left: 3px solid var(--vscode-descriptionForeground); border-radius: 3px; padding: 6px 8px; }
.card.queued { border-left-color: var(--vscode-descriptionForeground); }
.card.running { border-left-color: var(--vscode-charts-blue); }
.card.review { border-left-color: var(--vscode-charts-yellow); }
.card.merged { border-left-color: var(--vscode-testing-iconPassed); }
.card.failed { border-left-color: var(--vscode-testing-iconFailed); }
.card .title { font-weight: 600; font-size: 11px; margin-bottom: 2px; word-break: break-word; }
.card .id { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
.card .detail { font-size: 10px; color: var(--vscode-descriptionForeground); word-break: break-word;
  white-space: pre-wrap; }
#failedWrap { margin-top: 10px; }
#failedWrap h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--vscode-testing-iconFailed); margin: 0 0 6px; }
.empty { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 12px; text-align: center; }
</style></head>
<body>
<div id="header">
  <h2>Swarm Board</h2>
  <button id="stopAll" class="danger" title="Stop all running swarm units">Stop all</button>
</div>
<div id="board">
  <div class="col" data-col="queued"><h3>Queued <span class="count" id="count-queued">0</span></h3><div class="cards" id="cards-queued"></div></div>
  <div class="col" data-col="running"><h3>Running <span class="count" id="count-running">0</span></h3><div class="cards" id="cards-running"></div></div>
  <div class="col" data-col="review"><h3>Review <span class="count" id="count-review">0</span></h3><div class="cards" id="cards-review"></div></div>
  <div class="col" data-col="merged"><h3>Merged <span class="count" id="count-merged">0</span></h3><div class="cards" id="cards-merged"></div></div>
</div>
<div id="failedWrap" style="display:none">
  <h3>Failed</h3>
  <div class="cards" id="cards-failed"></div>
</div>
<div id="empty" class="empty">No swarm units yet — decompose a goal to fill the board.</div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
// -- local in-memory model -----------------------------------------------------
const state = { units: [] };
function applyEvent(evt) {
  const idx = state.units.findIndex((u) => u.unitId === evt.unitId);
  const unit = { unitId: evt.unitId, title: evt.title, status: evt.status, detail: evt.detail };
  if (idx === -1) state.units.push(unit);
  else state.units[idx] = unit;
  render();
}
function cardEl(unit) {
  const div = document.createElement('div');
  div.className = 'card ' + unit.status;
  const id = document.createElement('div');
  id.className = 'id';
  id.textContent = unit.unitId;
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = unit.title;
  div.appendChild(id);
  div.appendChild(title);
  if (unit.detail) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = unit.detail;
    div.appendChild(detail);
  }
  return div;
}
function render() {
  const cols = { queued: [], running: [], review: [], merged: [] };
  const failed = [];
  for (const u of state.units) {
    if (u.status === 'failed') failed.push(u);
    else if (cols[u.status]) cols[u.status].push(u);
  }
  for (const key of Object.keys(cols)) {
    const wrap = document.getElementById('cards-' + key);
    wrap.innerHTML = '';
    document.getElementById('count-' + key).textContent = String(cols[key].length);
    for (const u of cols[key]) wrap.appendChild(cardEl(u));
  }
  const failedWrap = document.getElementById('failedWrap');
  const failedCards = document.getElementById('cards-failed');
  failedCards.innerHTML = '';
  for (const u of failed) failedCards.appendChild(cardEl(u));
  failedWrap.style.display = failed.length ? '' : 'none';
  document.getElementById('empty').style.display = state.units.length ? 'none' : '';
}
// -- events --------------------------------------------------------------------
document.getElementById('stopAll').addEventListener('click', () => {
  vscodeApi.postMessage({ command: 'stopAll' });
});
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'sunday/swarm/event' || !msg.event) return;
  const evt = msg.event;
  if (typeof evt.unitId !== 'string' || typeof evt.status !== 'string') return;
  applyEvent(evt);
});
render();
</script>
</body></html>`;
  }
}

/**
 * Register the `sunday.swarmView` webview view. The returned disposable is the
 * provider itself, so the caller can cast it to `SwarmViewProvider` and feed
 * events via `pushSwarmEvent`.
 */
export function registerSwarmWebview(
  context: vscode.ExtensionContext,
  deps: { onStopAll?: () => void } = {},
): vscode.Disposable {
  const provider = new SwarmViewProvider({
    onStopAll: deps.onStopAll ?? (() => {}),
    log: (msg) => console.log(msg),
  });
  const registration = vscode.window.registerWebviewViewProvider(
    SwarmViewProvider.viewType,
    provider,
  );
  context.subscriptions.push(registration);
  return registration;
}
