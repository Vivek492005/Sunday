// sunday-agent — BrowserViewProvider: the "Agent Browser" panel (Browser
// Agent UI phase).
//
// A self-contained WebviewView (bottom panel area, alongside Terminal) that
// shows the agent browser's live screencast, a URL bar, and the control
// handover between agent and user. All browser work goes through the
// HostBridge `browser/panel/*` methods; sundayd enforces the takeover gate
// (agent action tools fail fast while the user holds control) — the panel
// only surfaces the state. vscode-free apart from the `vscode` import, so it
// stays unit-testable with a mocked `vscode` module.

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';
import { getCachedView } from './entitlements/provider.js';
import { BROWSER_PLAN_MESSAGE, browserAllowedByView } from './entitlements/browserGating.js';

export const BROWSER_VIEW_TYPE = 'sunday.browserView';

export interface BrowserViewDeps {
  /** Current bridge, if the sidecar is up. */
  getBridge: () => HostBridge | undefined;
  /** Start the sidecar if needed and return the bridge. */
  ensureBridge: () => Promise<HostBridge>;
  log: (msg: string) => void;
}

/** Frame poll cadence (§20: 2fps live image). */
export const BROWSER_FRAME_POLL_MS = 500;

type ControlState = 'agent' | 'user' | 'unknown';

export class BrowserViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = BROWSER_VIEW_TYPE;

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private control: ControlState = 'unknown';
  private currentUrl = '';
  /** Last surfaced frame-poll error — reported once, not every 500ms. */
  private lastFrameError: string | undefined;

  constructor(private readonly deps: BrowserViewDeps) {}

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
    webviewView.onDidChangeVisibility(() => this.updatePolling(), undefined, this.disposables);
    void this.refreshState();
    this.updatePolling();
  }

  /** Re-query control state when the bridge instance changes (sidecar restart/crash). */
  notifyBridgeChanged(): void {
    if (this.view) void this.refreshState();
  }

  /** Take over browser control (used by the `sunday.browser.takeover` command). */
  async takeOver(): Promise<void> {
    this.throwIfBrowserGated();
    const bridge = await this.deps.ensureBridge();
    await bridge.browserPanelTakeover();
    this.deps.log('browser view: user took over browser control');
    await this.refreshState();
  }

  /**
   * Task 7 gate: the browser agent is plan-gated. Uses the cached
   * entitlements (sync UI path) and FAILS OPEN when unknown — the daemon
   * re-checks before doing anything.
   */
  private browserEntitlementAllows(): boolean {
    try {
      return browserAllowedByView(getCachedView(this.deps.log));
    } catch (err) {
      this.deps.log(`browser view: entitlement check failed, failing open: ${(err as Error).message}`);
      return true;
    }
  }

  /** Throw the upsell message when the plan excludes the browser agent. */
  private throwIfBrowserGated(): void {
    if (!this.browserEntitlementAllows()) {
      throw new Error(BROWSER_PLAN_MESSAGE);
    }
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
    this.deps.log(`browser view: ${message}`);
    this.post({ type: 'sunday/browser/error', message });
  }

  private disposeView(): void {
    this.stopPolling();
    for (const d of this.disposables.splice(0)) d.dispose();
    this.view = undefined;
    this.control = 'unknown';
    this.lastFrameError = undefined;
  }

  // -- live frame polling ------------------------------------------------------

  /** Poll only while the view is visible; the screencast costs a frame per tick. */
  private updatePolling(): void {
    const shouldPoll = this.view?.visible === true;
    if (shouldPoll && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.pollFrame();
      }, BROWSER_FRAME_POLL_MS);
    } else if (!shouldPoll && this.pollTimer) {
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollFrame(): Promise<void> {
    if (this.view?.visible !== true) return; // visibility changed mid-tick
    const bridge = this.deps.getBridge();
    if (!bridge) return; // sidecar down — stay quiet until the next tick
    try {
      const { data } = await bridge.browserPanelFrame();
      this.lastFrameError = undefined;
      this.post({ type: 'sunday/browser/frame', data });
    } catch (err) {
      // A failed frame must never kill the poll loop. Surface the first
      // failure (e.g. "browser is disabled…") then stay quiet until it clears.
      const message = (err as Error).message;
      if (message !== this.lastFrameError) {
        this.lastFrameError = message;
        this.postError(`live view: ${message}`);
      }
    }
  }

  // -- state -------------------------------------------------------------------

  private async refreshState(): Promise<void> {
    // Task 7 gate: a plan without the browser agent sees the disabled
    // panel state (with the upsell tooltip) — never touch the bridge, so
    // browserd is never started for a gated plan.
    if (!this.browserEntitlementAllows()) {
      this.control = 'unknown';
      this.post({
        type: 'sunday/browser/state',
        state: {
          control: this.control,
          url: this.currentUrl,
          entitlementDisabled: true,
          error: BROWSER_PLAN_MESSAGE,
        },
      });
      return;
    }
    const bridge = this.deps.getBridge();
    if (!bridge) {
      this.control = 'unknown';
      this.post({
        type: 'sunday/browser/state',
        state: { control: this.control, url: this.currentUrl, error: 'Sunday sidecar is not running.' },
      });
      return;
    }
    try {
      const { control } = await bridge.browserPanelControl();
      this.control = control;
      this.post({ type: 'sunday/browser/state', state: { control, url: this.currentUrl } });
    } catch (err) {
      this.control = 'unknown';
      this.post({
        type: 'sunday/browser/state',
        state: { control: this.control, url: this.currentUrl, error: (err as Error).message },
      });
    }
  }

  // -- webview message routing ---------------------------------------------------

  private async onMessage(msg: unknown): Promise<void> {
    const m = msg as { type?: unknown; url?: unknown } & Record<string, unknown>;
    if (!m || typeof m.type !== 'string') return;
    // Task 7 gate: block every browser action for a gated plan — the panel
    // shows the disabled state instead, and browserd is never started.
    // ('ready' just re-renders state, which gates itself in refreshState.)
    if (m.type !== 'sunday/browser/ready' && !this.browserEntitlementAllows()) {
      this.postError(BROWSER_PLAN_MESSAGE);
      return;
    }
    try {
      switch (m.type) {
        case 'sunday/browser/ready':
          await this.refreshState();
          break;
        case 'sunday/browser/open': {
          const url = typeof m.url === 'string' ? m.url.trim() : '';
          if (!url) {
            this.postError('enter a URL to open');
            return;
          }
          const bridge = await this.deps.ensureBridge();
          const res = await bridge.browserPanelOpen(url);
          this.currentUrl = res.url ?? url;
          this.deps.log(`browser view: opened ${this.currentUrl}`);
          this.post({ type: 'sunday/browser/opened', url: this.currentUrl, title: res.title });
          await this.refreshState();
          break;
        }
        case 'sunday/browser/reload': {
          if (!this.currentUrl) {
            this.postError('nothing to reload — open a URL first');
            return;
          }
          const bridge = await this.deps.ensureBridge();
          const res = await bridge.browserPanelOpen(this.currentUrl);
          this.currentUrl = res.url ?? this.currentUrl;
          this.post({ type: 'sunday/browser/opened', url: this.currentUrl, title: res.title });
          break;
        }
        case 'sunday/browser/close': {
          const bridge = await this.deps.ensureBridge();
          await bridge.browserPanelClose();
          this.currentUrl = '';
          this.deps.log('browser view: session closed');
          this.post({ type: 'sunday/browser/closed' });
          await this.refreshState();
          break;
        }
        case 'sunday/browser/takeover':
          await this.takeOver();
          break;
        case 'sunday/browser/release': {
          const bridge = await this.deps.ensureBridge();
          await bridge.browserPanelRelease();
          this.deps.log('browser view: control returned to the agent');
          await this.refreshState();
          break;
        }
        case 'sunday/browser/screenshot': {
          const bridge = await this.deps.ensureBridge();
          const { data } = await bridge.browserPanelScreenshot();
          this.post({ type: 'sunday/browser/screenshot', data, ts: Date.now() });
          break;
        }
        default:
          this.deps.log(`browser view: ignoring unknown message type ${m.type}`);
      }
    } catch (err) {
      this.postError((err as Error).message);
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
#toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
#url { flex: 1; min-width: 120px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); padding: 4px 8px; font-size: 12px; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  border: none; padding: 4px 10px; cursor: pointer; font-size: 11px; white-space: nowrap; }
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.4; cursor: default; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
#banner { min-height: 18px; margin-bottom: 6px; }
.err { color: var(--vscode-testing-iconFailed); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
.notice { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder);
  padding: 8px; margin-bottom: 8px; font-size: 11px; }
.muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
#live { border: 1px solid var(--vscode-widget-border); min-height: 120px; display: flex; align-items: center;
  justify-content: center; background: var(--vscode-editor-background); margin-bottom: 8px; }
#live img { max-width: 100%; display: block; }
#controlRow { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.badge { font-size: 10px; padding: 1px 8px; border-radius: 8px; background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground); white-space: nowrap; }
.badge.user { background: var(--vscode-testing-iconFailed); color: #fff; }
.badge.agent { background: var(--vscode-testing-iconPassed); color: #fff; }
#shot { border: 1px solid var(--vscode-widget-border); margin-top: 6px; background: var(--vscode-editor-background); }
#shot img { max-width: 100%; display: block; }
h3 { margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground); }
</style></head>
<body>
<div id="banner" role="alert"></div>
<div id="toolbar">
  <input id="url" type="text" placeholder="https://…" spellcheck="false" aria-label="Browser URL" />
  <button id="open" class="primary">Open</button>
  <button id="reload" title="Re-open the current URL">Reload</button>
  <button id="close" title="Stop the screencast and close the browser session">Close session</button>
</div>
<div id="controlRow">
  <span id="controlBadge" class="badge" role="status">…</span>
  <button id="takeover" title="Hand browser control to yourself; agent actions pause">Take over</button>
  <button id="resume" title="Hand browser control back to the agent">Resume agent</button>
  <button id="shotBtn" title="Capture a one-shot screenshot">Screenshot</button>
</div>
<h3>Live view</h3>
<div id="live"><span class="muted" id="livePlaceholder">no frame yet — open a URL to start the agent browser</span><img id="liveImg" style="display:none" alt="agent browser live view" /></div>
<h3>Snapshot</h3>
<div id="shotWrap" style="display:none"><div class="muted" id="shotTs"></div><div id="shot"><img id="shotImg" alt="captured screenshot" /></div></div>
<div id="noShot" class="muted">no snapshot captured yet</div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const post = (type, extra) => vscodeApi.postMessage(Object.assign({ type }, extra || {}));
const $ = (id) => document.getElementById(id);
// -- state machine -------------------------------------------------------------
// control: 'agent' | 'user' | 'unknown'; disabled: browserd opt-in is off;
// entitlementDisabled: the plan doesn't include the browser agent (Task 7).
// Take over is only meaningful while the agent holds control; Resume only
// while the user holds it. Everything is inert until the daemon reports.
const state = { control: 'unknown', disabled: false, entitlementDisabled: false, entitlementMessage: '', hasSession: false };
function render() {
  const blocked = state.disabled || state.entitlementDisabled;
  const badge = $('controlBadge');
  badge.textContent = state.control === 'agent' ? 'agent control'
    : state.control === 'user' ? 'YOU have control' : 'control: unknown';
  badge.className = 'badge' + (state.control === 'agent' ? ' agent' : state.control === 'user' ? ' user' : '');
  $('takeover').disabled = blocked || state.control !== 'agent';
  $('resume').disabled = blocked || state.control !== 'user';
  $('open').disabled = blocked;
  $('reload').disabled = blocked || !state.hasSession;
  $('close').disabled = blocked || !state.hasSession;
  $('shotBtn').disabled = blocked || !state.hasSession;
  const banner = $('banner');
  banner.innerHTML = '';
  if (state.entitlementDisabled) {
    // Task 7: plan-gated — disabled panel with the upsell tooltip.
    const tip = state.entitlementMessage || 'Browser agent requires a Smart plan or higher';
    const div = document.createElement('div');
    div.className = 'notice';
    div.title = tip;
    div.textContent = tip + ' — upgrade your plan to use the agent browser.';
    banner.appendChild(div);
  } else if (state.disabled) {
    banner.innerHTML = '<div class="notice">Agent browser is disabled. Set <b>sunday.browser.enabled</b> to true and restart the sidecar to use it.</div>';
  }
  if (state.control === 'user') {
    banner.innerHTML += '<div class="notice">You have control of the browser — agent browser actions are paused until you resume.</div>';
  }
}
function showError(message) {
  const banner = $('banner');
  const div = document.createElement('div');
  div.className = 'err';
  div.textContent = message;
  banner.appendChild(div);
  setTimeout(() => div.remove(), 8000);
}
render();
// -- events --------------------------------------------------------------------
$('open').addEventListener('click', () => post('sunday/browser/open', { url: $('url').value }));
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') post('sunday/browser/open', { url: $('url').value }); });
$('reload').addEventListener('click', () => post('sunday/browser/reload'));
$('close').addEventListener('click', () => post('sunday/browser/close'));
$('takeover').addEventListener('click', () => post('sunday/browser/takeover'));
$('resume').addEventListener('click', () => post('sunday/browser/release'));
$('shotBtn').addEventListener('click', () => post('sunday/browser/screenshot'));
// -- inbound -------------------------------------------------------------------
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'sunday/browser/state': {
      const s = msg.state || {};
      state.control = s.control === 'agent' || s.control === 'user' ? s.control : 'unknown';
      state.disabled = typeof s.error === 'string' && s.error.indexOf('browser is disabled') !== -1;
      state.entitlementDisabled = s.entitlementDisabled === true;
      state.entitlementMessage = state.entitlementDisabled && typeof s.error === 'string' ? s.error : '';
      state.hasSession = !!s.url;
      if (s.url) $('url').value = s.url;
      if (s.error && !state.disabled && !state.entitlementDisabled) showError(s.error);
      render();
      break;
    }
    case 'sunday/browser/frame': {
      if (msg.data) {
        $('liveImg').src = 'data:image/jpeg;base64,' + msg.data;
        $('liveImg').style.display = 'block';
        $('livePlaceholder').style.display = 'none';
        state.hasSession = true;
        render();
      }
      break;
    }
    case 'sunday/browser/opened': {
      state.hasSession = true;
      if (msg.url) $('url').value = msg.url;
      render();
      break;
    }
    case 'sunday/browser/closed': {
      state.hasSession = false;
      $('liveImg').style.display = 'none';
      $('liveImg').removeAttribute('src');
      $('livePlaceholder').style.display = '';
      render();
      break;
    }
    case 'sunday/browser/screenshot': {
      if (msg.data) {
        $('shotImg').src = 'data:image/png;base64,' + msg.data;
        $('shotTs').textContent = 'captured ' + new Date(msg.ts || Date.now()).toLocaleTimeString();
        $('shotWrap').style.display = '';
        $('noShot').style.display = 'none';
      }
      break;
    }
    case 'sunday/browser/error':
      showError(msg.message || 'unknown error');
      break;
  }
});
post('sunday/browser/ready');
</script>
</body></html>`;
  }
}
