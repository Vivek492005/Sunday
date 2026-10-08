// Tests for the A3 artifacts panel: artifact discovery (session/type
// allowlists), the markdown renderer (escape-first), HTML sandbox
// attributes, mermaid fallback, and panel list/preview flows. `vscode`
// is mocked; the artifact dir is a tmp dir.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const registered = new Map<string, (...args: any[]) => unknown>();
  const panels: Array<{ webview: { html: string; onDidReceiveMessage: any }; reveal: any; onDidDispose: any }> = [];
  return {
    registered,
    panels,
    window: {
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      createWebviewPanel: vi.fn(() => {
        const panel = {
          webview: { html: '', onDidReceiveMessage: vi.fn() },
          reveal: vi.fn(),
          onDidDispose: vi.fn(),
          dispose: vi.fn(),
        };
        panels.push(panel);
        return panel;
      }),
    },
    commands: {
      registerCommand: vi.fn((id: string, fn: (...args: any[]) => unknown) => {
        registered.set(id, fn);
        return { dispose: () => undefined };
      }),
    },
    ViewColumn: { One: 1 },
  };
});

vi.mock('vscode', () => ({
  window: mocks.window,
  commands: mocks.commands,
  ViewColumn: mocks.ViewColumn,
}));

import {
  ARTIFACTS_OPEN_COMMAND,
  ArtifactsPanel,
  escapeHtml,
  listArtifacts,
  readArtifact,
  renderListHtml,
  renderMarkdown,
  renderPreviewHtml,
  registerArtifacts,
} from './artifactsPanel.js';

let baseDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.registered.clear();
  mocks.panels.length = 0;
  baseDir = mkdtempSync(join(tmpdir(), 'sunday-artifacts-'));
  mkdirSync(join(baseDir, 'sess1'), { recursive: true });
  writeFileSync(join(baseDir, 'sess1', 'report.html'), '<h1>hi</h1>');
  writeFileSync(join(baseDir, 'sess1', 'notes.md'), '# Title\n\n**bold**');
  writeFileSync(join(baseDir, 'sess1', 'diagram.mmd'), 'graph TD;A-->B;');
  writeFileSync(join(baseDir, 'sess1', 'ignore.txt'), 'nope');
  mkdirSync(join(baseDir, '..evil'), { recursive: true });
  writeFileSync(join(baseDir, '..evil', 'x.html'), 'evil');
});

function cleanup() {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(join(tmpdir(), '..evil'), { recursive: true, force: true });
}

describe('listArtifacts', () => {
  it('discovers html/md/mmd and skips other files and bad sessions', async () => {
    try {
      const found = await listArtifacts(baseDir);
      expect(found.map((a) => a.id).sort()).toEqual([
        'sess1/diagram',
        'sess1/notes',
        'sess1/report',
      ]);
      expect(found.find((a) => a.id === 'sess1/report')!.type).toBe('html');
      expect(found.find((a) => a.id === 'sess1/notes')!.type).toBe('markdown');
      expect(found.find((a) => a.id === 'sess1/diagram')!.type).toBe('mermaid');
    } finally {
      cleanup();
    }
  });

  it('returns [] for a missing dir', async () => {
    expect(await listArtifacts(join(baseDir, 'nope'))).toEqual([]);
    cleanup();
  });
});

describe('escapeHtml', () => {
  it('escapes markup', () => {
    expect(escapeHtml('<b>"x"&</b>')).toBe('&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;');
  });
});

describe('renderMarkdown', () => {
  it('renders headings, bold, code, and lists', () => {
    const html = renderMarkdown('# Title\n\n**bold** and `code`\n\n- a\n- b');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>a</li>');
  });

  it('escapes HTML before rendering (no injection)', () => {
    const html = renderMarkdown('# <script>alert(1)</script>\n\n**<img src=x>**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<h1>');
  });

  it('handles fenced code blocks', () => {
    const html = renderMarkdown('```js\nconst x = 1;\n```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('const x = 1;');
  });
});

describe('renderPreviewHtml', () => {
  const htmlArtifact = {
    id: 'sess1/report', session: 'sess1', title: 'report', type: 'html' as const,
    path: '/x', bytes: 100, mtimeMs: 0,
  };

  it('renders HTML in a sandboxed iframe (allow-scripts only)', () => {
    const out = renderPreviewHtml(htmlArtifact, '<h1>hi</h1><script>alert(1)</script>');
    expect(out).toContain('<iframe');
    expect(out).toContain('sandbox="allow-scripts"');
    expect(out).not.toContain('allow-same-origin');
  });

  it('renders markdown through the safe renderer', () => {
    const out = renderPreviewHtml(
      { ...htmlArtifact, type: 'markdown', id: 'sess1/notes' },
      '# Hi\n\n<script>evil</script>',
    );
    expect(out).not.toContain('<iframe');
    expect(out).toContain('<h1>Hi</h1>');
    expect(out).not.toContain('<script>evil</script>');
  });

  it('renders mermaid as a code block with a note (no runtime)', () => {
    const out = renderPreviewHtml(
      { ...htmlArtifact, type: 'mermaid', id: 'sess1/diagram' },
      'graph TD;A-->B;',
    );
    expect(out).toContain("isn't bundled");
    expect(out).toContain('graph TD;A--&gt;B;');
    expect(out).not.toContain('<iframe');
  });
});

describe('renderListHtml', () => {
  it('lists artifacts and handles the empty state', async () => {
    try {
      const found = await listArtifacts(baseDir);
      const html = renderListHtml(found);
      expect(html).toContain('report');
      expect(html).toContain('sess1');
      expect(renderListHtml([])).toContain('No artifacts yet');
    } finally {
      cleanup();
    }
  });
});

describe('ArtifactsPanel', () => {
  it('registers sunday.artifacts.open and reveals the list', async () => {
    const ctx = { subscriptions: [] as unknown[] } as unknown as import('vscode').ExtensionContext;
    registerArtifacts(ctx, { baseDir });
    expect(mocks.registered.has(ARTIFACTS_OPEN_COMMAND)).toBe(true);
    try {
      await (mocks.registered.get(ARTIFACTS_OPEN_COMMAND) as () => Promise<void>)();
      expect(mocks.panels).toHaveLength(1);
      expect(mocks.panels[0]!.webview.html).toContain('report');
    } finally {
      cleanup();
    }
  });

  it('opens an artifact preview on message', async () => {
    const panel = new ArtifactsPanel({ baseDir });
    try {
      await panel.reveal();
      const onMsg = mocks.panels[0]!.webview.onDidReceiveMessage.mock.calls[0]![0] as (
        m: unknown,
      ) => void;
      onMsg({ command: 'open', id: 'sess1/report' });
      await new Promise((r) => setTimeout(r, 20));
      const html = mocks.panels[0]!.webview.html;
      expect(html).toContain('sandbox="allow-scripts"');
      expect(html).toContain('← All artifacts');
      // back navigates to the list
      onMsg({ command: 'back' });
      await new Promise((r) => setTimeout(r, 20));
      expect(mocks.panels[0]!.webview.html).toContain('notes');
    } finally {
      cleanup();
    }
  });

  it('shows an error for unknown artifact ids', async () => {
    const panel = new ArtifactsPanel({ baseDir });
    try {
      await panel.reveal();
      const onMsg = mocks.panels[0]!.webview.onDidReceiveMessage.mock.calls[0]![0] as (
        m: unknown,
      ) => void;
      onMsg({ command: 'open', id: 'sess1/nope' });
      await new Promise((r) => setTimeout(r, 20));
      expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('not found'),
      );
    } finally {
      cleanup();
    }
  });
});

describe('readArtifact', () => {
  it('reads content', async () => {
    try {
      const [a] = await listArtifacts(baseDir);
      const content = await readArtifact(a!);
      expect(content.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
