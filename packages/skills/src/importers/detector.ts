/**
 * Auto-detection of foreign tool configs.
 *
 * Scans the workspace directory and the user's home directory for known
 * config files from Claude Code/Desktop, Cursor, Windsurf, Cline, Gemini
 * CLI and VS Code. Pure: all IO goes through the injectable FsLike.
 */
import { join } from 'node:path';
import type { FsLike } from './fs.js';
import type { DetectedSource, ImportSourceKind } from './types.js';

export interface DetectOptions {
  workspaceDir: string;
  /** Defaults to fs.homedir(). */
  homeDir?: string;
  fs: FsLike;
  /** Defaults to process.env (only APPDATA is read, on win32). */
  env?: Record<string, string | undefined>;
}

interface Candidate {
  kind: ImportSourceKind;
  label: string;
  scope: 'workspace' | 'user';
  /** Absolute path. */
  path: string;
}

function vscodeUserDir(fs: FsLike, home: string, env: Record<string, string | undefined>): string {
  const p = fs.platform();
  if (p === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Code', 'User');
  if (p === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User');
  return join(home, '.config', 'Code', 'User');
}

function claudeDesktopConfig(fs: FsLike, home: string, env: Record<string, string | undefined>): string {
  const p = fs.platform();
  if (p === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (p === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

function windsurfMcp(fs: FsLike, home: string): string {
  return join(home, '.codeium', 'windsurf', 'mcp_config.json');
}

/**
 * List every foreign source present on disk. Directories (like
 * `.cursor/rules/`) are reported when they exist and contain at least one
 * `.md`/`.mdc` file.
 */
export async function detectImports(opts: DetectOptions): Promise<DetectedSource[]> {
  const { workspaceDir, fs } = opts;
  const home = opts.homeDir ?? fs.homedir();
  const env = opts.env ?? process.env;

  const candidates: Candidate[] = [
    // --- workspace rule files ---
    { kind: 'claude-md', label: 'CLAUDE.md', scope: 'workspace', path: join(workspaceDir, 'CLAUDE.md') },
    { kind: 'gemini-md', label: 'GEMINI.md', scope: 'workspace', path: join(workspaceDir, 'GEMINI.md') },
    { kind: 'cursor-rules-file', label: '.cursorrules', scope: 'workspace', path: join(workspaceDir, '.cursorrules') },
    { kind: 'windsurf-rules', label: '.windsurfrules', scope: 'workspace', path: join(workspaceDir, '.windsurfrules') },
    { kind: 'cline-rules', label: '.clinerules', scope: 'workspace', path: join(workspaceDir, '.clinerules') },
    // --- workspace MCP configs ---
    { kind: 'mcp-cursor-workspace', label: '.cursor/mcp.json', scope: 'workspace', path: join(workspaceDir, '.cursor', 'mcp.json') },
    { kind: 'mcp-cline-workspace', label: '.cline/mcp_settings.json', scope: 'workspace', path: join(workspaceDir, '.cline', 'mcp_settings.json') },
  ];

  const vsDir = vscodeUserDir(fs, home, env);
  candidates.push(
    { kind: 'vscode-settings', label: 'VS Code settings.json', scope: 'user', path: join(vsDir, 'settings.json') },
    { kind: 'vscode-keybindings', label: 'VS Code keybindings.json', scope: 'user', path: join(vsDir, 'keybindings.json') },
    { kind: 'mcp-claude-desktop', label: 'Claude Desktop MCP config', scope: 'user', path: claudeDesktopConfig(fs, home, env) },
    { kind: 'mcp-claude-code', label: 'Claude Code ~/.claude.json', scope: 'user', path: join(home, '.claude.json') },
    { kind: 'mcp-cursor-user', label: 'Cursor user MCP config', scope: 'user', path: join(home, '.cursor', 'mcp.json') },
    { kind: 'mcp-windsurf', label: 'Windsurf MCP config', scope: 'user', path: windsurfMcp(fs, home) },
  );

  const found: DetectedSource[] = [];
  for (const c of candidates) {
    if ((await fs.readFile(c.path)) !== null) {
      found.push({ kind: c.kind, path: c.path, label: c.label, scope: c.scope });
    }
  }

  // .cursor/rules/ — directory of per-rule markdown files.
  const rulesDir = join(workspaceDir, '.cursor', 'rules');
  const entries = await fs.readdir(rulesDir);
  if (entries && entries.some((e) => e.endsWith('.md') || e.endsWith('.mdc'))) {
    found.push({
      kind: 'cursor-rules-dir',
      path: rulesDir,
      label: '.cursor/rules/',
      scope: 'workspace',
    });
  }

  // VS Code settings.json can also carry MCP servers (mcp.servers / chat.mcp).
  // That is handled by the MCP converter reading the already-detected file,
  // so we register a virtual source only when the settings file parses and
  // actually contains MCP config — checked in planImport.

  return found;
}
