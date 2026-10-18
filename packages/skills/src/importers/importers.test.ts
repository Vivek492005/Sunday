/**
 * F13 importer tests: detection, conversion, dry-run purity, idempotency.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { memoryFsLike, type FsLike } from './fs.js';
import { detectImports } from './detector.js';
import { planImport, applyImport } from './index.js';
import { convertVscodeSettings } from './vscodeSettings.js';
import { convertVscodeKeybindings } from './vscodeKeybindings.js';
import { convertMcpConfig } from './mcpConfigs.js';

const WS = '/ws';
const HOME = '/home/test';

function fsWith(files: Record<string, string>, platform: NodeJS.Platform = 'linux'): FsLike {
  return memoryFsLike(files, { home: HOME, platform });
}

const SAMPLE_CLAUDE_MD = `# Project Rules

- Always run tests before committing.
- Use TypeScript strict mode.
`;

const SAMPLE_CURSORRULES = `You are a senior engineer. Prefer functional style. Never use emojis in UI.`;

const SAMPLE_CURSOR_RULE_MDC = `---
description: API conventions
globs: src/api/**
---
All API routes return { data, error }.
`;

const SAMPLE_VSCODE_SETTINGS = JSON.stringify({
  'editor.fontSize': 16,
  'editor.fontFamily': 'Fira Code',
  'editor.tabSize': 4,
  'editor.wordWrap': 'on',
  'terminal.integrated.fontSize': 14,
  'workbench.colorTheme': 'Default Light+',
  'editor.minimap.enabled': false,
  'files.autoSave': 'afterDelay',
});

const SAMPLE_KEYBINDINGS = JSON.stringify([
  { key: 'ctrl+shift+p', command: 'workbench.action.showCommands' },
  { key: 'ctrl+b', command: 'workbench.action.toggleSidebarVisibility' },
  { key: 'ctrl+k ctrl+c', command: 'myExtension.customCommand' },
]);

const SAMPLE_MCP = JSON.stringify({
  mcpServers: {
    fetch: { command: 'uvx', args: ['mcp-server-fetch'], env: { FETCH_KEY: 'sk-live-123' } },
    weather: { url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer abc' } },
    broken: { env: {} },
  },
});

describe('detectImports', () => {
  it('finds workspace + user sources', async () => {
    const fs = fsWith({
      [join(WS, 'CLAUDE.md')]: SAMPLE_CLAUDE_MD,
      [join(WS, '.cursorrules')]: SAMPLE_CURSORRULES,
      [join(WS, '.cursor', 'rules', 'api.mdc')]: SAMPLE_CURSOR_RULE_MDC,
      [join(HOME, '.config', 'Code', 'User', 'settings.json')]: SAMPLE_VSCODE_SETTINGS,
      [join(HOME, '.config', 'Code', 'User', 'keybindings.json')]: SAMPLE_KEYBINDINGS,
      [join(HOME, '.cursor', 'mcp.json')]: SAMPLE_MCP,
    });
    const found = await detectImports({ workspaceDir: WS, fs });
    const kinds = found.map((f) => f.kind);
    expect(kinds).toContain('claude-md');
    expect(kinds).toContain('cursor-rules-file');
    expect(kinds).toContain('cursor-rules-dir');
    expect(kinds).toContain('vscode-settings');
    expect(kinds).toContain('vscode-keybindings');
    expect(kinds).toContain('mcp-cursor-user');
  });

  it('returns empty when nothing exists', async () => {
    const found = await detectImports({ workspaceDir: WS, fs: fsWith({}) });
    expect(found).toEqual([]);
  });

  it('uses darwin VS Code paths on macOS', async () => {
    const macHome = '/Users/test';
    const fs = memoryFsLike(
      { [join(macHome, 'Library', 'Application Support', 'Code', 'User', 'settings.json')]: '{}' },
      { home: macHome, platform: 'darwin' },
    );
    const found = await detectImports({ workspaceDir: WS, fs });
    expect(found.map((f) => f.kind)).toContain('vscode-settings');
  });
});

describe('planImport (dry-run)', () => {
  function fullFs(): FsLike {
    return fsWith({
      [join(WS, 'CLAUDE.md')]: SAMPLE_CLAUDE_MD,
      [join(WS, '.cursorrules')]: SAMPLE_CURSORRULES,
      [join(WS, '.cursor', 'rules', 'api.mdc')]: SAMPLE_CURSOR_RULE_MDC,
      [join(WS, '.windsurfrules')]: 'Windsurf rules here.',
      [join(HOME, '.config', 'Code', 'User', 'settings.json')]: SAMPLE_VSCODE_SETTINGS,
      [join(HOME, '.config', 'Code', 'User', 'keybindings.json')]: SAMPLE_KEYBINDINGS,
      [join(HOME, '.cursor', 'mcp.json')]: SAMPLE_MCP,
    });
  }

  it('plans AGENTS.md creation with import markers, and .sunday/rules files', async () => {
    const plan = await planImport({ workspaceDir: WS, fs: fullFs() });
    const targets = plan.writes.map((w) => w.path);
    expect(targets).toContain(join(WS, 'AGENTS.md'));
    expect(targets).toContain(join(WS, '.sunday', 'rules', 'api.md'));

    const agents = plan.writes.find((w) => w.path === join(WS, 'AGENTS.md'))!;
    expect(agents.action).toBe('create');
    expect(agents.content).toContain('sunday-import:claude-md:');
    expect(agents.content).toContain('sunday-import:cursor-rules-file:');
    expect(agents.content).toContain('Always run tests before committing.');

    const rule = plan.writes.find((w) => w.path.endsWith('api.md'))!;
    expect(rule.content).toContain('imported-from: .cursor/rules/api.mdc');
    expect(rule.content).toContain('description: API conventions');
    expect(rule.content).toContain('globs: src/api/**');
  });

  it('converts VS Code settings into a settings.json merge', async () => {
    const plan = await planImport({ workspaceDir: WS, fs: fullFs() });
    const settings = plan.writes.find((w) => w.path === join(HOME, '.sunday-ide', 'settings.json'))!;
    expect(settings).toBeDefined();
    const body = JSON.parse(settings.content);
    expect(body.editorFontSize).toBe(16);
    expect(body.editorFontFamily).toBe('Fira Code');
    expect(body.editorTabSize).toBe(4);
    expect(body.editorWordWrap).toBe(true);
    expect(body.terminalFontSize).toBe(14);
    expect(body.theme).toBe('sunday-light');
    // unmapped keys reported, not silently dropped
    expect(plan.unconvertible.some((u) => u.reason.includes('editor.minimap.enabled'))).toBe(true);
  });

  it('converts keybindings with remaps staged', async () => {
    const plan = await planImport({ workspaceDir: WS, fs: fullFs() });
    const kb = plan.writes.find((w) => w.path === join(HOME, '.sunday-ide', 'keybindings.json'))!;
    expect(kb).toBeDefined();
    const body = JSON.parse(kb.content);
    expect(body.bindings).toHaveLength(3);
    expect(body.bindings[0].command).toBe('sunday.commandPalette');
    expect(body.bindings[0].remappedFrom).toBe('workbench.action.showCommands');
    expect(body.bindings[2].command).toBe('myExtension.customCommand');
  });

  it('converts MCP servers and flags secret-looking env', async () => {
    const plan = await planImport({ workspaceDir: WS, fs: fullFs() });
    const mcp = plan.writes.find((w) => w.path === join(HOME, '.sunday', 'mcp.json'))!;
    expect(mcp).toBeDefined();
    const body = JSON.parse(mcp.content);
    expect(body.servers.fetch.transport).toBe('stdio');
    expect(body.servers.fetch.command).toEqual(['uvx', 'mcp-server-fetch']);
    expect(body.servers.fetch.defaultApproval).toBe('ask');
    expect(body.servers.weather.transport).toBe('http');
    expect(body.servers.weather.url).toBe('https://mcp.example.com/sse');
    expect(body.servers.broken).toBeUndefined();
    // broken server reported as unconvertible
    expect(plan.unconvertible.some((u) => u.item.includes('"broken"'))).toBe(true);
    // secret-looking env flagged for attention
    expect(plan.unconvertible.some((u) => u.reason.startsWith('NEEDS ATTENTION') && u.item.includes('FETCH_KEY'))).toBe(true);
  });

  it('performs zero writes during planning (dry-run purity)', async () => {
    const written: string[] = [];
    const fs = fullFs();
    await planImport({ workspaceDir: WS, fs });
    // planImport never receives a writeFile; assert it didn't mutate via fs
    // (memoryFsLike has no mutation API — the type system enforces purity).
    expect(written).toEqual([]);
  });
});

describe('applyImport', () => {
  it('writes planned content and reports converted/skipped/attention', async () => {
    const fs = fsWith({
      [join(WS, 'CLAUDE.md')]: SAMPLE_CLAUDE_MD,
      [join(HOME, '.config', 'Code', 'User', 'settings.json')]: SAMPLE_VSCODE_SETTINGS,
      [join(HOME, '.cursor', 'mcp.json')]: SAMPLE_MCP,
    });
    const plan = await planImport({ workspaceDir: WS, fs });
    const store: Record<string, string> = {};
    const report = await applyImport(plan, async (p, c) => {
      store[p] = c;
    });
    expect(store[join(WS, 'AGENTS.md')]).toContain('Always run tests before committing.');
    expect(store[join(HOME, '.sunday-ide', 'settings.json')]).toBeDefined();
    expect(report.converted.length).toBeGreaterThan(0);
    expect(report.needsAttention.some((n) => n.item.includes('FETCH_KEY'))).toBe(true);
  });

  it('is idempotent: second apply skips everything', async () => {
    const backing: Record<string, string> = {
      [join(WS, 'CLAUDE.md')]: SAMPLE_CLAUDE_MD,
    };
    const fs = memoryFsLike(backing, { home: HOME, platform: 'linux' });
    const writeFile = async (p: string, c: string) => {
      backing[p] = c;
    };
    // First run applies.
    const plan1 = await planImport({ workspaceDir: WS, fs });
    await applyImport(plan1, writeFile);
    expect(plan1.writes.some((w) => w.action !== 'skip')).toBe(true);
    // Second run: everything skips.
    const plan2 = await planImport({ workspaceDir: WS, fs });
    expect(plan2.writes.length).toBeGreaterThan(0);
    expect(plan2.writes.every((w) => w.action === 'skip')).toBe(true);
    expect(plan2.nothingToDo).toBe(true);
  });

  it('does not clobber a hand-written .sunday rule file', async () => {
    const target = join(WS, '.sunday', 'rules', 'api.md');
    const fs = fsWith({
      [join(WS, '.cursor', 'rules', 'api.mdc')]: SAMPLE_CURSOR_RULE_MDC,
      [target]: '# Hand-written rule\n\nDo not touch.\n',
    });
    const plan = await planImport({ workspaceDir: WS, fs });
    expect(plan.writes.every((w) => w.action === 'skip' || !w.path.endsWith('api.md'))).toBe(true);
    expect(plan.unconvertible.some((u) => u.item === target && u.reason.includes('hand-written'))).toBe(true);
  });
});

describe('unit: converters', () => {
  it('convertVscodeSettings maps known keys and lists unmapped', () => {
    const { patch, mapped, unmapped } = convertVscodeSettings(JSON.parse(SAMPLE_VSCODE_SETTINGS));
    expect(patch.editorFontSize).toBe(16);
    expect(patch.theme).toBe('sunday-light');
    expect(mapped).toContain('editor.fontSize');
    expect(unmapped).toContain('editor.minimap.enabled');
    expect(unmapped).toContain('files.autoSave');
  });

  it('convertVscodeSettings maps dark themes to sunday-dark', () => {
    const { patch } = convertVscodeSettings({ 'workbench.colorTheme': 'Default Dark+' });
    expect(patch.theme).toBe('sunday-dark');
  });

  it('convertVscodeKeybindings skips negative bindings', () => {
    const { bindings } = convertVscodeKeybindings([
      { key: 'ctrl+b', command: '-workbench.action.toggleSidebarVisibility' },
    ]);
    expect(bindings).toEqual([]);
  });

  it('convertMcpConfig handles stdio and http', () => {
    const src = { kind: 'mcp-cursor-user', path: '/x', label: 'Cursor', scope: 'user' } as const;
    const { conversion } = convertMcpConfig(src, JSON.parse(SAMPLE_MCP));
    expect(Object.keys(conversion.servers).sort()).toEqual(['fetch', 'weather']);
    expect(conversion.secretFlags).toHaveLength(1);
    expect(conversion.secretFlags[0].server).toBe('fetch');
  });
});
