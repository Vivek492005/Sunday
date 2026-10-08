// Mission Control dashboard (Group A, A4).
//
// `sunday.missionControl` opens a webview aggregating all running work:
// orchestrator runs, browser sessions, cloud tasks (A1) and scheduled
// tasks (A5). Cards show name, status, elapsed time and last log lines
// with Stop / Restart buttons wired to each source. The host pushes a
// fresh snapshot every 2s while the panel is visible.
//
// vscode-coupled; logic is in types.ts/sources.ts and unit-tested there.
// This module only owns the panel lifecycle and HTML.
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { HostBridge } from '../hostBridge.js';
import type { CloudTaskClient } from '../cloudTasks.js';
import type { SchedulerSource } from '../scheduler.js';
import { aggregateWork, type WorkItem, type WorkSource } from './types.js';
import {
  makeBrowserSource,
  makeCloudTaskSource,
  makeOrchestrationSource,
  makeScheduleSource,
  type BrowserSessionInfo,
} from './sources.js';

export const MISSION_CONTROL_COMMAND = 'sunday.missionControl';
export const MISSION_CONTROL_VIEW_ID = 'sunday.missionControlView';

/** Refresh interval while the panel is visible. */
export const MISSION_CONTROL_REFRESH_MS = 2000;

export interface MissionControlDeps {
  getBridge: () => Promise<HostBridge | undefined>;
  makeCloudTaskClient: () => CloudTaskClient;
  scheduler: SchedulerSource;
  getOrchestrationRunIds: () => string[];
  getBrowserSessions: () => BrowserSessionInfo[];
  closeBrowserSession: (id: string) => Promise<void>;
  log: (msg: string) => void;
}

function buildSources(deps: MissionControlDeps): WorkSource[] {
  return [
    makeOrchestrationSource({ ...deps, getRunIds: deps.getOrchestrationRunIds }),
    makeBrowserSource({
      ...deps,
      getSessions: deps.getBrowserSessions,
      closeSession: deps.closeBrowserSession,
    }),
    makeCloudTaskSource({ ...deps, makeClient: deps.makeCloudTaskClient }),
    makeScheduleSource(deps.scheduler, deps.log),
  ];
}

/** Dispatch a Stop/Restart action to the right source. Exported for tests. */
export async function dispatchCardAction(
  sources: WorkSource[],
  kind: WorkItem['kind'],
  action: 'stop' | 'restart',
  id: string,
): Promise<void> {
  const src = sources.find((s) => s.kind === kind);
  if (!src) throw new Error(`No source for kind "${kind}".`);
  const items = await src.list();
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`Item "${id}" not found.`);
  if (action === 'stop') await src.stop(item);
  else await src.restart(item);
}

export class MissionControlPanel {
  private panel: vscode.WebviewPanel | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly sources: WorkSource[];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: MissionControlDeps,
  ) {
    this.sources = buildSources(deps);
  }

  /** For tests: the live source list. */
  getSources(): WorkSource[] {
    return this.sources;
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      MISSION_CONTROL_VIEW_ID,
      'Sunday Mission Control',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg).catch((err) => this.deps.log(`mission control: ${(err as Error).message}`)),
      undefined,
      this.context.subscriptions,
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    }, undefined, this.context.subscriptions);
    void this.pushUpdate();
    this.timer = setInterval(() => void this.pushUpdate(), MISSION_CONTROL_REFRESH_MS);
  }

  private async onMessage(msg: unknown): Promise<void> {
    const m = msg as { command?: string; kind?: WorkItem['kind']; id?: string };
    if (!m || typeof m.command !== 'string') return;
    if (m.command === 'refresh') {
      await this.pushUpdate();
      return;
    }
    if ((m.command === 'stop' || m.command === 'restart') && m.kind && typeof m.id === 'string') {
      try {
        await dispatchCardAction(this.sources, m.kind, m.command, m.id);
      } catch (err) {
        this.deps.log(`mission control ${m.command} failed: ${(err as Error).message}`);
        vscode.window.showErrorMessage(`Mission Control: ${(err as Error).message}`);
      }
      await this.pushUpdate();
      return;
    }
    this.deps.log(`mission control: ignoring unknown command ${m.command}`);
  }

  private async pushUpdate(): Promise<void> {
    if (!this.panel) return;
    const { items, errors } = await aggregateWork(this.sources);
    const sections = this.sources.map((s) => ({
      kind: s.kind,
      label: s.label,
      emptyNote: s.emptyNote ?? '',
      items: items.filter((i) => i.kind === s.kind),
    }));
    await this.panel.webview.postMessage({ type: 'update', sections, errors, now: Date.now() });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp =
      `<meta http-equiv="Content-Security-Policy" ` +
      `content="default-src 'none'; script-src 'nonce-${nonce}'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline';">`;
    return `<!DOCTYPE html>
<html><head>${csp}
<style>
body { font-family: var(--vscode-font-family); font-size: 12px; padding: 12px; color: var(--vscode-foreground); }
#header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
#header h2 { font-size: 14px; margin: 0; flex: 1; }
#header .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  border: none; padding: 4px 10px; cursor: pointer; font-size: 11px; white-space: nowrap; border-radius: 2px; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.danger { background: var(--vscode-testing-iconFailed); color: #fff; }
button:disabled { opacity: 0.4; cursor: default; }
button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
.section { margin-bottom: 16px; }
.section > h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--vscode-descriptionForeground); margin: 0 0 8px; display: flex; gap: 6px; align-items: center; }
.count { font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  border-radius: 8px; padding: 0 6px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
.card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border);
  border-left: 3px solid var(--vscode-charts-blue); border-radius: 3px; padding: 8px 10px; }
.card[data-status="failed"] { border-left-color: var(--vscode-testing-iconFailed); }
.card[data-status="completed"] { border-left-color: var(--vscode-testing-iconPassed); }
.card[data-status="disabled"] { border-left-color: var(--vscode-descriptionForeground); opacity: 0.75; }
.card .title { font-weight: 600; font-size: 12px; margin-bottom: 2px; word-break: break-word; }
.card .row { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
.card .row b { color: var(--vscode-foreground); font-weight: 600; }
.card .log { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; white-space: pre-wrap;
  word-break: break-word; background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border); border-radius: 2px; padding: 4px 6px; margin: 6px 0; }
.card .actions { display: flex; gap: 6px; margin-top: 6px; }
.empty { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 10px; text-align: center;
  border: 1px dashed var(--vscode-widget-border); border-radius: 3px; }
#errors { margin-top: 12px; }
#errors .err { color: var(--vscode-testing-iconFailed); font-size: 11px; margin-bottom: 2px; }
</style></head>
<body>
<div id="header">
  <h2>Sunday Mission Control</h2>
  <span class="meta" id="updated"></span>
  <button id="refreshBtn" title="Refresh now">Refresh</button>
</div>
<div id="sections"></div>
<div id="errors"></div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
let lastNow = Date.now();
function render(sections, errors, now) {
  lastNow = now;
  document.getElementById('updated').textContent = 'updated ' + new Date(now).toLocaleTimeString();
  const wrap = document.getElementById('sections');
  wrap.innerHTML = sections.map((sec) => {
    const cards = sec.items.length
      ? sec.items.map((it) => \`
        <div class="card" data-status="\${esc(it.status)}">
          <div class="title">\${esc(it.name)}</div>
          <div class="row">status: <b>\${esc(it.status)}</b> · elapsed: <b data-elapsed data-started="\${it.startedAt}">\${fmtElapsed(now - it.startedAt)}</b></div>
          \${it.lastLog.length ? '<div class="log">' + it.lastLog.map(esc).join('\\n') + '</div>' : ''}
          <div class="actions">
            <button class="danger" data-act="stop" data-kind="\${esc(it.kind)}" data-id="\${esc(it.id)}" \${it.stoppable ? '' : 'disabled'}>Stop</button>
            <button data-act="restart" data-kind="\${esc(it.kind)}" data-id="\${esc(it.id)}" \${it.restartable ? '' : 'disabled'}>Restart</button>
          </div>
        </div>\`).join('')
      : '<div class="empty">' + esc(sec.emptyNote || 'Nothing here.') + '</div>';
    return '<div class="section"><h3>' + esc(sec.label) + ' <span class="count">' + sec.items.length + '</span></h3><div class="cards">' + cards + '</div></div>';
  }).join('');
  document.getElementById('errors').innerHTML = errors.map((e) => '<div class="err">' + esc(e) + '</div>').join('');
  wrap.querySelectorAll('button[data-act]').forEach((b) => {
    b.addEventListener('click', () => vscodeApi.postMessage({ command: b.dataset.act, kind: b.dataset.kind, id: b.dataset.id }));
  });
}
// Tick elapsed counters locally between 2s snapshots.
setInterval(() => {
  document.querySelectorAll('[data-elapsed]').forEach((el) => {
    el.textContent = fmtElapsed(Date.now() - Number(el.dataset.started));
  });
}, 1000);
document.getElementById('refreshBtn').addEventListener('click', () => vscodeApi.postMessage({ command: 'refresh' }));
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m && m.type === 'update') render(m.sections, m.errors, m.now);
});
</script>
</body></html>`;
  }
}

export function registerMissionControl(
  context: vscode.ExtensionContext,
  deps: MissionControlDeps,
): MissionControlPanel {
  const panel = new MissionControlPanel(context, deps);
  context.subscriptions.push(
    vscode.commands.registerCommand(MISSION_CONTROL_COMMAND, () => panel.open()),
  );
  return panel;
}
