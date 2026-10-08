// sunday-agent — "Sunday Usage" dashboard webview (D2).
//
// Command `sunday.usage.show` opens a WebviewPanel with inline-SVG bar
// charts (no external CDN, no network beyond the gateway call itself):
// today's totals, per-model bars, and a 7-day history.
//
// Rendering is server-side in the extension host (pure functions below,
// unit-tested): the webview only has a Refresh button that re-fetches.
// Graceful states: loading, gateway unreachable, sign-in required, error.

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
  fetchUsageSnapshot,
  getSessionToken,
  resolveGatewayUrl,
  DEFAULT_GATEWAY_URL,
  GatewayAuthError,
  GatewayUnreachableError,
  type GatewayFetch,
  type UsageSnapshot,
} from './gatewayClient.js';

/** WebviewPanel view type for the usage dashboard. */
export const USAGE_VIEW_TYPE = 'sunday.usageView';
/** Command id: open the Sunday Usage dashboard. */
export const USAGE_SHOW_COMMAND = 'sunday.usage.show';

export interface UsagePanelDeps {
  /** fetch implementation (default: global fetch). */
  fetchImpl?: GatewayFetch;
  /** Override the session-token lookup (tests). */
  getToken?: () => Promise<string | undefined>;
  /** Override the gateway URL (tests). */
  gatewayUrl?: string;
  log?: (msg: string) => void;
}

/** Escape text for HTML interpolation (model names are server-supplied). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** Compact number: 1500 -> "1.5k". */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Inline SVG vertical bar chart for the 7-day history. */
export function historyChart(history: UsageSnapshot['history_7d']): string {
  const W = 350;
  const H = 110;
  const max = Math.max(1, ...history.map((p) => p.requests));
  const bw = W / history.length;
  const bars = history
    .map((p, i) => {
      const h = Math.round((p.requests / max) * (H - 26));
      const x = Math.round(i * bw + bw * 0.2);
      const w = Math.round(bw * 0.6);
      const y = H - 20 - h;
      const label = escapeHtml(p.day.slice(5));
      return (
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="var(--vscode-charts-blue, #3794ff)">` +
        `<title>${escapeHtml(p.day)}: ${p.requests} requests</title></rect>` +
        `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle" font-size="9" ` +
        `fill="var(--vscode-descriptionForeground, #999)">${label}</text>`
      );
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Requests per day, last 7 days">${bars}</svg>`;
}

/** Horizontal per-model bars (up to 10 models). */
export function modelBars(models: UsageSnapshot['by_model']): string {
  const top = models.slice(0, 10);
  if (top.length === 0) {
    return `<p class="empty">No requests yet — send a chat message to see per-model usage.</p>`;
  }
  const max = Math.max(1, ...top.map((m) => m.tokens));
  const rows = top
    .map((m) => {
      const pct = Math.max(2, Math.round((m.tokens / max) * 100));
      return (
        `<div class="mrow">` +
        `<span class="mname" title="${escapeHtml(m.model)}">${escapeHtml(m.model)}</span>` +
        `<span class="mbar"><span class="mfill" style="width:${pct}%"></span></span>` +
        `<span class="mval">${m.requests} req · ${compact(m.tokens)} tok</span>` +
        `</div>`
      );
    })
    .join('');
  return `<div class="models">${rows}</div>`;
}

/** Pure: dashboard body HTML for a validated snapshot (empty data included). */
export function renderUsageHtml(s: UsageSnapshot): string {
  const t = s.today;
  return `
<div class="cards">
  <div class="card"><div class="cnum">${t.requests}</div><div class="clabel">requests today</div></div>
  <div class="card"><div class="cnum">${compact(t.tokens_in)}</div><div class="clabel">tokens in today</div></div>
  <div class="card"><div class="cnum">${compact(t.tokens_out)}</div><div class="clabel">tokens out today</div></div>
</div>
<h3>Per model</h3>
${modelBars(s.by_model)}
<h3>Last 7 days</h3>
${historyChart(s.history_7d)}
<p class="note">Free-tier usage resets daily at UTC midnight. Metering is in-memory on the gateway — a gateway restart resets these counters.</p>`;
}

export type UsagePanelState = 'loading' | 'unreachable' | 'auth' | 'error';

/** Pure: friendly state HTML for loading / failure modes. */
export function renderUsageState(state: UsagePanelState, detail = ''): string {
  switch (state) {
    case 'loading':
      return `<p class="empty">Loading usage…</p>`;
    case 'unreachable':
      return `<div class="state"><h3>Gateway unreachable</h3><p>Could not reach the Sunday gateway at <code>${escapeHtml(detail)}</code>.</p><p>Check your connection, then press Refresh.</p></div>`;
    case 'auth':
      return `<div class="state"><h3>Sign in required</h3><p>Usage stats need a Sunday session. Sign in with Google (Sunday Account in the status bar), then press Refresh.</p></div>`;
    case 'error':
      return `<div class="state"><h3>Could not load usage</h3><p>${escapeHtml(detail)}</p><p>Press Refresh to try again.</p></div>`;
  }
}

/** Full webview page: CSP-nonces scripts, VS Code theme variables, Refresh. */
export function renderUsagePage(bodyHtml: string, nonce: string, cspSource: string): string {
  const csp =
    `<meta http-equiv="Content-Security-Policy" ` +
    `content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline';">`;
  return `<!DOCTYPE html>
<html><head>${csp}
<style>
body { font-family: var(--vscode-font-family); font-size: 12px; padding: 12px 16px; color: var(--vscode-foreground); }
#header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
#header h2 { font-size: 14px; margin: 0; flex: 1; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  border: none; padding: 4px 12px; cursor: pointer; font-size: 12px; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.cards { display: flex; gap: 10px; margin-bottom: 4px; }
.card { flex: 1; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border);
  border-radius: 6px; padding: 12px; text-align: center; }
.cnum { font-size: 22px; font-weight: 600; }
.clabel { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
h3 { font-size: 12px; margin: 16px 0 8px; color: var(--vscode-descriptionForeground);
  text-transform: uppercase; letter-spacing: 0.05em; }
.mrow { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.mname { flex: 0 0 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.mbar { flex: 1; height: 10px; background: var(--vscode-sideBar-background); border-radius: 5px; overflow: hidden; }
.mfill { display: block; height: 100%; background: var(--vscode-charts-blue, #3794ff); border-radius: 5px; }
.mval { flex: 0 0 130px; text-align: right; font-size: 11px; color: var(--vscode-descriptionForeground); }
.empty, .note { color: var(--vscode-descriptionForeground); font-size: 11px; }
.state { max-width: 420px; margin: 32px auto; text-align: center; }
.state code { font-size: 11px; }
</style></head>
<body>
<div id="header"><h2>Sunday Usage</h2><button id="refresh">Refresh</button></div>
<div id="body">${bodyHtml}</div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
document.getElementById('refresh').addEventListener('click', () => {
  vscodeApi.postMessage({ command: 'usage/refresh' });
});
</script>
</body></html>`;
}

/**
 * Register the `sunday.usage.show` command. Creates (or reveals) the usage
 * panel; the panel re-fetches on Refresh. All data paths degrade to the
 * friendly states above — never a blank panel or a crash.
 */
export function registerUsageCommands(
  context: vscode.ExtensionContext,
  deps: UsagePanelDeps = {},
): vscode.Disposable {
  const log = deps.log ?? (() => undefined);
  const fetchImpl: GatewayFetch =
    deps.fetchImpl ??
    (async (url: string, init?: { headers?: Record<string, string> }) => {
      const r = await fetch(url, init);
      return { ok: r.ok, status: r.status, json: () => r.json() as Promise<unknown> };
    });

  let panel: vscode.WebviewPanel | undefined;

  const gatewayUrl = (): string => {
    if (deps.gatewayUrl) return deps.gatewayUrl;
    try {
      return resolveGatewayUrl(vscode.workspace.getConfiguration('sunday'));
    } catch {
      return DEFAULT_GATEWAY_URL;
    }
  };

  const getToken = async (): Promise<string | undefined> => {
    if (deps.getToken) return deps.getToken();
    return getSessionToken({
      getExtensionExports: (id) => vscode.extensions.getExtension(id)?.exports,
      secretGet: async (key) => {
        const v = await context.secrets.get(key);
        return v ?? undefined;
      },
    });
  };

  const setBody = (bodyHtml: string): void => {
    if (!panel) return;
    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = renderUsagePage(bodyHtml, nonce, panel.webview.cspSource);
  };

  const refresh = async (): Promise<void> => {
    setBody(renderUsageState('loading'));
    const url = gatewayUrl();
    try {
      const token = await getToken();
      if (!token) {
        setBody(renderUsageState('auth'));
        return;
      }
      const snapshot = await fetchUsageSnapshot(fetchImpl, url, token);
      setBody(renderUsageHtml(snapshot));
    } catch (err) {
      log(`usage: refresh failed: ${(err as Error).message}`);
      if (err instanceof GatewayAuthError) setBody(renderUsageState('auth'));
      else if (err instanceof GatewayUnreachableError) setBody(renderUsageState('unreachable', url));
      else setBody(renderUsageState('error', (err as Error).message));
    }
  };

  const show = (): void => {
    if (panel) {
      panel.reveal();
      void refresh();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      USAGE_VIEW_TYPE,
      'Sunday Usage',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
    panel.webview.onDidReceiveMessage((msg: unknown) => {
      const m = msg as { command?: unknown };
      if (m && m.command === 'usage/refresh') void refresh();
    });
    void refresh();
  };

  return vscode.commands.registerCommand(USAGE_SHOW_COMMAND, show);
}
