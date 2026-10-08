// sunday-agent — Artifacts panel (Group A, A3).
//
// Webview panel listing the agent's `create_artifact` output under
// ~/.sunday/artifacts/<session>/. Clicking an artifact previews it:
//   - HTML: sandboxed iframe (sandbox="allow-scripts" ONLY — never
//    allow-same-origin, so artifact scripts can't touch the IDE).
//   - Markdown: escaped, then rendered by a minimal built-in renderer.
//   - Mermaid: source shown as a code block (no mermaid runtime bundled).
//
// Pure HTML builders are exported for unit tests; the panel class is thin.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const ARTIFACTS_OPEN_COMMAND = 'sunday.artifacts.open';

/** Max bytes read for preview (tool caps writes at 500KB; be generous). */
export const ARTIFACT_PREVIEW_MAX_BYTES = 1024 * 1024;

export interface ArtifactInfo {
  id: string; // "<session>/<slug>"
  session: string;
  title: string; // slug
  type: 'html' | 'markdown' | 'mermaid';
  path: string;
  bytes: number;
  mtimeMs: number;
}

const EXT_TO_TYPE: Record<string, ArtifactInfo['type']> = {
  '.html': 'html',
  '.md': 'markdown',
  '.mmd': 'mermaid',
};

/** HTML-escape untrusted artifact content before embedding. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Minimal Markdown renderer. The input is ESCAPED FIRST, then a small set
 * of constructs is recognized: headings, fenced code, bold, italic, inline
 * code, unordered lists, paragraphs. Deliberately small — no link/image
 * handling (artifact HTML covers rich content).
 */
export function renderMarkdown(md: string): string {
  const esc = escapeHtml(md);
  const lines = esc.split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  const inline = (s: string): string =>
    s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const line of lines) {
    if (/^```/.test(line)) {
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(item[1]!)}</li>`);
      continue;
    }
    if (/^\s*$/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

/** Discover artifacts under baseDir (= ~/.sunday/artifacts). Newest first. */
export async function listArtifacts(baseDir: string): Promise<ArtifactInfo[]> {
  const found: ArtifactInfo[] = [];
  let sessions: string[];
  try {
    sessions = await fs.promises.readdir(baseDir);
  } catch {
    return [];
  }
  for (const session of sessions) {
    // Session segment allowlist mirrors the tool's sanitizeSessionId.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(session)) continue;
    const dir = path.join(baseDir, session);
    let files: string[];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const type = EXT_TO_TYPE[ext];
      if (!type) continue;
      // Slug allowlist mirrors the tool's slugifyTitle output.
      const slug = path.basename(file, ext);
      if (!/^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$/.test(slug)) continue;
      const full = path.join(dir, file);
      let st;
      try {
        st = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      found.push({
        id: `${session}/${slug}`,
        session,
        title: slug,
        type,
        path: full,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

/** Read artifact content with a size guard. */
export async function readArtifact(a: ArtifactInfo): Promise<string> {
  const st = await fs.promises.stat(a.path);
  if (st.size > ARTIFACT_PREVIEW_MAX_BYTES) {
    throw new Error(`artifact too large to preview (${st.size} bytes)`);
  }
  return fs.promises.readFile(a.path, 'utf8');
}

/** Preview HTML for one artifact (pure, unit-tested). */
export function renderPreviewHtml(a: ArtifactInfo, content: string): string {
  const head = `<div class="crumb"><a href="#" data-back="1">← All artifacts</a>
    <span class="meta">${escapeHtml(a.id)} · ${escapeHtml(a.type)} · ${(a.bytes / 1024).toFixed(1)} KB</span></div>`;
  if (a.type === 'html') {
    // srcdoc must escape double quotes; sandbox="allow-scripts" ONLY —
    // no allow-same-origin, so artifact JS is isolated from the IDE.
    const srcdoc = content.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `${head}<iframe sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe>
      <script>document.querySelector('[data-back]').addEventListener('click',e=>{e.preventDefault();api.postMessage({command:'back'});});</script>`;
  }
  if (a.type === 'markdown') {
    return `${head}<div class="md">${renderMarkdown(content)}</div>
      <script>document.querySelector('[data-back]').addEventListener('click',e=>{e.preventDefault();api.postMessage({command:'back'});});</script>`;
  }
  // mermaid: no runtime bundled — show source with a note.
  return `${head}<div class="note">Mermaid rendering isn't bundled in the IDE — showing diagram source.</div>
    <pre><code>${escapeHtml(content)}</code></pre>
    <script>document.querySelector('[data-back]').addEventListener('click',e=>{e.preventDefault();api.postMessage({command:'back'});});</script>`;
}

/** List HTML for the panel (pure, unit-tested). */
export function renderListHtml(artifacts: ArtifactInfo[]): string {
  const rows = artifacts
    .map(
      (a) => `<div class="row" data-open="${escapeHtml(a.id)}">
        <span class="t badge">${escapeHtml(a.type)}</span>
        <span class="title">${escapeHtml(a.title)}</span>
        <span class="sess">${escapeHtml(a.session)}</span>
      </div>`,
    )
    .join('\n');
  return rows || '<p class="empty">No artifacts yet. Ask the agent to create one (e.g. “make an HTML mockup”).</p>';
}

const PANEL_CSS = `
  body { font-family: var(--vscode-font-family); padding: 12px 16px; color: var(--vscode-foreground); }
  .row { display: flex; gap: 10px; align-items: center; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 4px; padding: 1px 8px; font-size: .8em; }
  .sess { opacity: .6; font-size: .85em; margin-left: auto; }
  .empty { opacity: .7; }
  .crumb { margin-bottom: 10px; } .crumb .meta { opacity: .6; margin-left: 12px; font-size: .85em; }
  iframe { width: 100%; height: calc(100vh - 80px); border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: #fff; }
  .md { max-width: 860px; } .md pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow: auto; }
  .note { opacity: .7; margin-bottom: 8px; font-size: .9em; }
  pre code { font-family: var(--vscode-editor-font-family); }
`;

function shell(inner: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PANEL_CSS}</style></head>
  <body><div id="app">${inner}</div>
  <script>const api = acquireVsCodeApi();
    document.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () =>
      api.postMessage({ command: 'open', id: el.getAttribute('data-open') })));
  </script></body></html>`;
}

export interface ArtifactsPanelDeps {
  /** Base dir; defaults to ~/.sunday/artifacts (injectable for tests). */
  baseDir?: string;
  log?: (msg: string) => void;
}

export class ArtifactsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private readonly baseDir: string;

  constructor(private readonly deps: ArtifactsPanelDeps = {}) {
    this.baseDir = deps.baseDir ?? path.join(os.homedir(), '.sunday', 'artifacts');
  }

  async reveal(): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'sunday.artifactsView',
        'Sunday Artifacts',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.webview.onDidReceiveMessage(
        (msg: unknown) => {
          void this.onMessage(msg).catch((err: Error) =>
            vscode.window.showErrorMessage(`Artifacts: ${(err as Error).message}`),
          );
        },
        undefined,
        [],
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }
    this.panel.reveal();
    await this.showList();
  }

  private async showList(): Promise<void> {
    if (!this.panel) return;
    const artifacts = await listArtifacts(this.baseDir);
    this.panel.webview.html = shell(
      `<h2>Artifacts</h2>${renderListHtml(artifacts)}`,
    );
  }

  private async onMessage(msg: unknown): Promise<void> {
    const m = msg as { command?: string; id?: string };
    if (!this.panel) return;
    if (m?.command === 'back') {
      await this.showList();
      return;
    }
    if (m?.command === 'open' && typeof m.id === 'string') {
      const artifacts = await listArtifacts(this.baseDir);
      const a = artifacts.find((x) => x.id === m.id);
      if (!a) {
        vscode.window.showErrorMessage(`Artifact not found: ${m.id}`);
        return;
      }
      const content = await readArtifact(a);
      this.panel.webview.html = shell(renderPreviewHtml(a, content));
    }
  }
}

export function registerArtifacts(
  context: vscode.ExtensionContext,
  deps: ArtifactsPanelDeps = {},
): void {
  const panel = new ArtifactsPanel(deps);
  context.subscriptions.push(
    vscode.commands.registerCommand(ARTIFACTS_OPEN_COMMAND, () => panel.reveal()),
  );
}
