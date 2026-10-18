/**
 * F13 — Compatibility & Migration Layer ("Bring everything with you").
 *
 * Shared types for the one-click importer that detects foreign tool configs
 * (CLAUDE.md, .cursorrules, .windsurfrules, .clinerules, GEMINI.md,
 * VS Code settings/keybindings, foreign MCP configs) and converts them into
 * Sunday's canonical formats (AGENTS.md, .sunday/rules, ~/.sunday-ide
 * settings, ~/.sunday/mcp.json).
 *
 * All converters are pure (injectable fs) so they are unit-testable and the
 * dry-run path provably performs zero writes.
 */

/** Every foreign source the importer knows how to detect/convert. */
export type ImportSourceKind =
  | 'claude-md'
  | 'gemini-md'
  | 'cursor-rules-file'
  | 'cursor-rules-dir'
  | 'windsurf-rules'
  | 'cline-rules'
  | 'vscode-settings'
  | 'vscode-keybindings'
  | 'mcp-claude-desktop'
  | 'mcp-claude-code'
  | 'mcp-cursor-user'
  | 'mcp-cursor-workspace'
  | 'mcp-windsurf'
  | 'mcp-cline-workspace'
  | 'mcp-vscode-settings';

/** A foreign config file found on disk. */
export interface DetectedSource {
  kind: ImportSourceKind;
  /** Absolute path of the foreign file. */
  path: string;
  /** Human label, e.g. "CLAUDE.md". */
  label: string;
  /** workspace | user — decides where converted output lands. */
  scope: 'workspace' | 'user';
}

export type WriteAction = 'create' | 'append' | 'merge' | 'overwrite' | 'skip';

/** One planned file write (dry-run friendly). */
export interface PlannedWrite {
  /** Absolute target path. */
  path: string;
  action: WriteAction;
  /** Short human summary, e.g. "Append 42 lines to AGENTS.md". */
  summary: string;
  /** Full content to write (empty for skips). */
  content: string;
  /** First ~500 chars of content (for the dry-run preview). */
  preview: string;
  /** Set when the write will be skipped — explains why. */
  skipReason?: string;
}

/** One thing that could not be converted automatically. */
export interface UnconvertibleItem {
  source: string;
  item: string;
  reason: string;
}

/** Dry-run plan: computed with zero side effects. */
export interface ImportPlan {
  workspaceDir: string;
  detected: DetectedSource[];
  writes: PlannedWrite[];
  unconvertible: UnconvertibleItem[];
  /** True when every write is a skip (nothing to do). */
  nothingToDo: boolean;
}

/** Outcome of applying a plan. */
export interface ImportReport {
  appliedAt: string;
  converted: { source: string; target: string; detail: string }[];
  skipped: { source: string; target: string; reason: string }[];
  needsAttention: { source: string; item: string; reason: string }[];
}

/** Sunday settings subset the importer can fill from VS Code settings. */
export interface SundaySettingsPatch {
  theme?: 'sunday-dark' | 'sunday-light';
  editorFontSize?: number;
  editorFontFamily?: string;
  editorTabSize?: number;
  editorWordWrap?: boolean;
  terminalFontSize?: number;
}

/** Canonical Sunday keybinding entry (staged for the future keybinding engine). */
export interface SundayKeybinding {
  key: string;
  command: string;
  when?: string;
  /** Original VS Code command, when remapped. */
  remappedFrom?: string;
}

/** Canonical Sunday MCP server entry (mirrors @sunday/mcp McpServerConfig). */
export interface SundayMcpServer {
  transport: 'stdio' | 'http';
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  defaultApproval: 'allow' | 'ask';
}

/** Write function injected so tests can use an in-memory fs. */
export type WriteFile = (path: string, content: string) => Promise<void>;
export type ReadFile = (path: string) => Promise<string | null>;
