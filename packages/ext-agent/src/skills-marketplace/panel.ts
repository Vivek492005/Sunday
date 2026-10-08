// sunday-agent — skills marketplace browser (D4).
//
// Command `sunday.skills.browse` opens a WebviewPanel listing community
// skills from a registry JSON document (default: community-skills.json on
// the Sunday repo's main branch). Install downloads SKILL.md into
// ~/.sunday/skills/<name>/; uninstall removes the directory.
//
// Rendering is done host-side (pure functions, unit-tested); the webview
// only forwards button clicks. Downloaded skills are NEVER executed —
// SKILL.md is markdown documentation the agent reads on demand.

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import {
  installSkill,
  isInstalled,
  listInstalled,
  uninstallSkill,
  SkillAlreadyInstalledError,
  SkillInstallError,
  type DownloadFetch,
} from './installer.js';
import { parseRegistry, type ParsedRegistry, type RegistrySkill } from './registry.js';

/** Command id: open the skills marketplace. */
export const SKILLS_BROWSE_COMMAND = 'sunday.skills.browse';
/** WebviewPanel view type. */
export const SKILLS_VIEW_TYPE = 'sunday.skillsView';
/** Default registry document. */
export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/Vivek492005/Sunday/main/community-skills.json';

export class RegistryFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryFetchError';
  }
}

/** Structural shape of `vscode.workspace.getConfiguration('sunday')`. */
export interface SkillsConfigSource {
  get<T>(key: string, def: T): T;
}

/** Resolve the registry URL: setting first, then the built-in default. */
export function resolveRegistryUrl(cfg: SkillsConfigSource): string {
  const custom = cfg.get<string>('skills.registryUrl', '').trim();
  return custom || DEFAULT_REGISTRY_URL;
}

/** Fetch + parse the registry. Throws RegistryFetchError when unreachable. */
export async function fetchRegistry(
  fetchImpl: DownloadFetch,
  url: string,
): Promise<ParsedRegistry> {
  let res: Awaited<ReturnType<DownloadFetch>>;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new RegistryFetchError(`registry unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new RegistryFetchError(`registry request failed (HTTP ${res.status})`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
  } catch {
    throw new RegistryFetchError('registry returned invalid JSON');
  }
  return parseRegistry(doc);
}

/** Escape text for HTML interpolation. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export type MarketplaceState = 'loading' | 'unavailable' | 'error';

/** Pure: friendly state HTML (loading / registry-unavailable / error). */
export function renderMarketplaceState(state: MarketplaceState, detail = ''): string {
  switch (state) {
    case 'loading':
      return `<p class="empty">Loading skills…</p>`;
    case 'unavailable':
      return (
        `<div class="state"><h3>Registry unavailable</h3>` +
        `<p>Could not load the community skills registry${detail ? ` at <code>${escapeHtml(detail)}</code>` : ''}.</p>` +
        `<p>Check your connection, then press Refresh. Skills you already installed keep working.</p></div>`
      );
    case 'error':
      return `<div class="state"><h3>Something went wrong</h3><p>${escapeHtml(detail)}</p><p>Press Refresh to try again.</p></div>`;
  }
}

/** Pure: skill cards HTML. `installed` = names already in ~/.sunday/skills. */
export function renderMarketplaceHtml(
  skills: RegistrySkill[],
  installed: Set<string>,
  rejectedCount: number,
): string {
  const cards = skills
    .map((s) => {
      const isIn = installed.has(s.name);
      const action = isIn
        ? `<button data-action="uninstall" data-name="${escapeHtml(s.name)}">Uninstall</button>`
        : `<button data-action="install" data-name="${escapeHtml(s.name)}" class="primary">Install</button>`;
      return (
        `<div class="skill">` +
        `<div class="shead"><span class="sname">${escapeHtml(s.name)}</span>` +
        `<span class="sver">v${escapeHtml(s.version)}</span>` +
        (isIn ? `<span class="installed">installed</span>` : '') +
        `</div>` +
        `<p class="sdesc">${escapeHtml(s.description)}</p>` +
        `<div class="sfoot"><span class="sauthor">by ${escapeHtml(s.author)}</span>${action}</div>` +
        `</div>`
      );
    })
    .join('');
  const rejectedNote =
    rejectedCount > 0
      ? `<p class="note">${rejectedCount} registry entr${rejectedCount === 1 ? 'y was' : 'ies were'} rejected (failed validation).</p>`
      : '';
  const empty = skills.length === 0 ? `<p class="empty">No skills in this registry yet.</p>` : '';
  return `${cards}${empty}${rejectedNote}
<p class="note">Skills are community markdown files installed to <code>~/.sunday/skills/</code>. They are never executed automatically — review SKILL.md before use.</p>`;
}

/** Full webview page with CSP nonce; buttons post messages to the host. */
export function renderMarketplacePage(bodyHtml: string, nonce: string, cspSource: string): string {
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
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
.skill { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border);
  border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
.shead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.sname { font-weight: 600; font-size: 13px; }
.sver { font-size: 11px; color: var(--vscode-descriptionForeground); }
.installed { font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  border-radius: 8px; padding: 1px 8px; margin-left: auto; }
.sdesc { margin: 4px 0 8px; color: var(--vscode-foreground); }
.sfoot { display: flex; align-items: center; justify-content: space-between; }
.sauthor { font-size: 11px; color: var(--vscode-descriptionForeground); }
.empty, .note { color: var(--vscode-descriptionForeground); font-size: 11px; }
.note code { font-size: 11px; }
.state { max-width: 440px; margin: 32px auto; text-align: center; }
</style></head>
<body>
<div id="header"><h2>Sunday Skills</h2><button id="refresh">Refresh</button></div>
<div id="body">${bodyHtml}</div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
document.getElementById('refresh').addEventListener('click', () => {
  vscodeApi.postMessage({ command: 'skills/refresh' });
});
document.getElementById('body').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  vscodeApi.postMessage({ command: 'skills/' + btn.dataset.action, name: btn.dataset.name });
});
</script>
</body></html>`;
}

export interface MarketplaceDeps {
  fetchImpl?: DownloadFetch;
  homeDir?: string;
  registryUrl?: string;
  log?: (msg: string) => void;
}

/**
 * Register the `sunday.skills.browse` command. Thin shell: registry fetch,
 * install/uninstall delegate to the tested modules above.
 */
export function registerMarketplaceCommands(
  context: vscode.ExtensionContext,
  deps: MarketplaceDeps = {},
): vscode.Disposable {
  const log = deps.log ?? (() => undefined);
  const homeDir = deps.homeDir ?? os.homedir();
  const fetchImpl: DownloadFetch =
    deps.fetchImpl ??
    (async (url: string) => {
      const r = await fetch(url);
      return {
        ok: r.ok,
        status: r.status,
        headers: { get: (n: string) => r.headers.get(n) },
        arrayBuffer: () => r.arrayBuffer(),
      };
    });

  let panel: vscode.WebviewPanel | undefined;
  let lastRegistry: ParsedRegistry | undefined;

  const registryUrl = (): string => {
    if (deps.registryUrl) return deps.registryUrl;
    try {
      return resolveRegistryUrl(vscode.workspace.getConfiguration('sunday'));
    } catch {
      return DEFAULT_REGISTRY_URL;
    }
  };

  const setBody = (bodyHtml: string): void => {
    if (!panel) return;
    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = renderMarketplacePage(bodyHtml, nonce, panel.webview.cspSource);
  };

  const renderList = (): void => {
    if (!lastRegistry) return;
    const installed = new Set(listInstalled(homeDir).map((s) => s.name));
    setBody(renderMarketplaceHtml(lastRegistry.skills, installed, lastRegistry.rejected.length));
  };

  const refresh = async (): Promise<void> => {
    setBody(renderMarketplaceState('loading'));
    const url = registryUrl();
    try {
      lastRegistry = await fetchRegistry(fetchImpl, url);
      renderList();
    } catch (err) {
      log(`skills marketplace: refresh failed: ${(err as Error).message}`);
      if (err instanceof RegistryFetchError) setBody(renderMarketplaceState('unavailable', url));
      else setBody(renderMarketplaceState('error', (err as Error).message));
    }
  };

  const show = (): void => {
    if (panel) {
      panel.reveal();
      void refresh();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      SKILLS_VIEW_TYPE,
      'Sunday Skills',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => {
      panel = undefined;
      lastRegistry = undefined;
    });
    panel.webview.onDidReceiveMessage((msg: unknown) => {
      const m = msg as { command?: unknown; name?: unknown };
      if (!m || typeof m.command !== 'string') return;
      if (m.command === 'skills/refresh') {
        void refresh();
        return;
      }
      if ((m.command === 'skills/install' || m.command === 'skills/uninstall') && typeof m.name === 'string') {
        void (async () => {
          try {
            const skill = lastRegistry?.skills.find((s) => s.name === m.name);
            if (m.command === 'skills/install') {
              if (!skill) return;
              await installSkill(skill, { fetchImpl, homeDir });
              void vscode.window.showInformationMessage(`Skill "${skill.name}" installed.`);
            } else {
              const removed = uninstallSkill(homeDir, m.name as string);
              void vscode.window.showInformationMessage(
                removed ? `Skill "${m.name}" uninstalled.` : `Skill "${m.name}" was not installed.`,
              );
            }
          } catch (err) {
            const msgText =
              err instanceof SkillAlreadyInstalledError || err instanceof SkillInstallError
                ? (err as Error).message
                : `Skill operation failed: ${(err as Error).message}`;
            log(`skills marketplace: ${msgText}`);
            void vscode.window.showErrorMessage(msgText);
          }
          renderList();
        })();
        return;
      }
      log(`skills marketplace: ignoring unknown command ${String(m.command)}`);
    });
    void refresh();
  };

  void context; // reserved: future versions persist marketplace prefs in globalState
  return vscode.commands.registerCommand(SKILLS_BROWSE_COMMAND, show);
}
