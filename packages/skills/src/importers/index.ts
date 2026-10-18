/**
 * F13 — "Bring everything with you" importer: orchestration.
 *
 *   detectImports() → what foreign configs exist
 *   planImport()    → dry-run: zero writes, full preview of what would happen
 *   applyImport()   → execute a plan, returning an ImportReport
 *
 * All IO goes through the injectable FsLike + WriteFile, so the whole flow
 * is unit-testable with an in-memory fs.
 */
import { join } from 'node:path';
import { detectImports } from './detector.js';
import type { FsLike } from './fs.js';
import { planAgentsMdBatch, planRuleSource } from './agentsMd.js';
import {
  convertMcpConfig,
  extractForeignServers,
  isMcpSource,
  mcpSecretAttentionItems,
  parseJson,
} from './mcpConfigs.js';
import {
  convertVscodeKeybindings,
  keybindingAttentionItems,
} from './vscodeKeybindings.js';
import {
  convertVscodeSettings,
  parseSettingsJson,
  unmappedSettingsItems,
} from './vscodeSettings.js';
import type {
  DetectedSource,
  ImportPlan,
  ImportReport,
  PlannedWrite,
  SundayKeybinding,
  SundayMcpServer,
  UnconvertibleItem,
  WriteFile,
} from './types.js';

export { detectImports } from './detector.js';
export { nodeFsLike, memoryFsLike } from './fs.js';
export type { FsLike } from './fs.js';
export type {
  DetectedSource,
  ImportPlan,
  ImportReport,
  ImportSourceKind,
  PlannedWrite,
  SundayKeybinding,
  SundayMcpServer,
  SundaySettingsPatch,
  UnconvertibleItem,
  WriteAction,
  WriteFile,
} from './types.js';

export interface ImportOptions {
  workspaceDir: string;
  homeDir?: string;
  fs: FsLike;
  env?: Record<string, string | undefined>;
}

function sundayIdeDir(home: string): string {
  return join(home, '.sunday-ide');
}
function sundayUserDir(home: string): string {
  return join(home, '.sunday');
}

function skipWrite(path: string, summary: string, reason: string): PlannedWrite {
  return { path, action: 'skip', summary, content: '', preview: '', skipReason: reason };
}

/** Plan the VS Code settings.json conversion (settings + embedded MCP). */
async function planVscodeSettings(
  source: DetectedSource,
  opts: ImportOptions,
  home: string,
  readFile: (p: string) => Promise<string | null>,
  writes: PlannedWrite[],
  unconvertible: UnconvertibleItem[],
  attention: UnconvertibleItem[],
): Promise<void> {
  const raw = await readFile(source.path);
  if (raw === null) return;
  const parsed = parseSettingsJson(raw);
  if (!parsed) {
    unconvertible.push({ source: source.label, item: source.path, reason: 'Invalid JSON — skipped.' });
    return;
  }
  const conv = convertVscodeSettings(parsed);
  const target = join(sundayIdeDir(home), 'settings.json');
  const existingRaw = await readFile(target);
  const existing = parseSettingsJson(existingRaw ?? '') ?? {};
  const merged = { ...existing, ...conv.patch };
  const VSCODE_TO_PATCH: Record<string, keyof typeof conv.patch> = {
    'editor.fontSize': 'editorFontSize',
    'editor.fontFamily': 'editorFontFamily',
    'editor.tabSize': 'editorTabSize',
    'editor.wordWrap': 'editorWordWrap',
    'terminal.integrated.fontSize': 'terminalFontSize',
    'workbench.colorTheme': 'theme',
  };
  const alreadySame =
    existingRaw !== null &&
    conv.mapped.every(
      (k) =>
        JSON.stringify((existing as Record<string, unknown>)[VSCODE_TO_PATCH[k]]) ===
        JSON.stringify(conv.patch[VSCODE_TO_PATCH[k]]),
    );

  if (conv.mapped.length === 0) {
    writes.push(skipWrite(target, 'VS Code settings: nothing Sunday understands — skipped.', 'no-mappable-keys'));
  } else if (alreadySame) {
    writes.push(skipWrite(target, 'Sunday settings already match VS Code values — skipped.', 'already-imported'));
  } else {
    const content = `${JSON.stringify(merged, null, 2)}\n`;
    writes.push({
      path: target,
      action: existingRaw === null ? 'create' : 'merge',
      summary: `${existingRaw === null ? 'Create' : 'Merge into'} ~/.sunday-ide/settings.json: ${conv.mapped.join(', ')}.`,
      content,
      preview: content.slice(0, 500),
    });
  }
  unconvertible.push(...unmappedSettingsItems(source.label, conv.unmapped));

  // MCP servers embedded in VS Code settings (mcp.servers / mcp).
  const embedded = extractForeignServers(parsed);
  if (Object.keys(embedded).length > 0) {
    await planMcpMerge(
      { kind: 'mcp-vscode-settings', path: source.path, label: `${source.label} (embedded MCP)`, scope: 'user' },
      parsed,
      opts,
      home,
      readFile,
      writes,
      unconvertible,
      attention,
    );
  }
}

/** Plan the VS Code keybindings.json conversion. */
async function planVscodeKeybindings(
  source: DetectedSource,
  home: string,
  readFile: (p: string) => Promise<string | null>,
  writes: PlannedWrite[],
  unconvertible: UnconvertibleItem[],
  attention: UnconvertibleItem[],
): Promise<void> {
  const raw = await readFile(source.path);
  if (raw === null) return;
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    unconvertible.push({ source: source.label, item: source.path, reason: 'Invalid JSON array — skipped.' });
    return;
  }
  const conv = convertVscodeKeybindings(parsed);
  if (conv.bindings.length === 0) {
    writes.push(skipWrite(join(sundayIdeDir(home), 'keybindings.json'), 'No usable keybindings found — skipped.', 'empty'));
    return;
  }
  const target = join(sundayIdeDir(home), 'keybindings.json');
  const existingRaw = await readFile(target);
  const existingParsed = parseJson(existingRaw ?? '');
  const existingBindings: SundayKeybinding[] =
    existingParsed && typeof existingParsed === 'object' && Array.isArray((existingParsed as { bindings?: unknown }).bindings)
      ? ((existingParsed as { bindings: SundayKeybinding[] }).bindings)
      : [];
  const seen = new Set(existingBindings.map((b) => `${b.key}::${b.command}`));
  const fresh = conv.bindings.filter((b) => !seen.has(`${b.key}::${b.command}`));
  if (fresh.length === 0) {
    writes.push(skipWrite(target, 'All keybindings already staged — skipped.', 'already-imported'));
  } else {
    const content = `${JSON.stringify({ version: 1, bindings: [...existingBindings, ...fresh] }, null, 2)}\n`;
    writes.push({
      path: target,
      action: existingRaw === null ? 'create' : 'merge',
      summary: `Stage ${fresh.length} keybinding(s) in ~/.sunday-ide/keybindings.json (${conv.remapped.length} remapped to Sunday commands).`,
      content,
      preview: content.slice(0, 500),
    });
  }
  attention.push(...keybindingAttentionItems(source.label, conv));
}

/** Merge converted MCP servers into the Sunday mcp.json for the scope. */
async function planMcpMerge(
  source: DetectedSource,
  parsed: unknown,
  opts: ImportOptions,
  home: string,
  readFile: (p: string) => Promise<string | null>,
  writes: PlannedWrite[],
  unconvertible: UnconvertibleItem[],
  attention: UnconvertibleItem[],
): Promise<void> {
  const { conversion, unconvertible: convBad } = convertMcpConfig(source, parsed);
  unconvertible.push(...convBad);
  const names = Object.keys(conversion.servers);
  if (names.length === 0) return;

  const target =
    source.scope === 'workspace'
      ? join(opts.workspaceDir, '.sunday', 'mcp.json')
      : join(sundayUserDir(home), 'mcp.json');
  const existingRaw = await readFile(target);
  const existingParsed = parseJson(existingRaw ?? '');
  const existingServers: Record<string, SundayMcpServer> =
    existingParsed && typeof existingParsed === 'object' && typeof (existingParsed as { servers?: unknown }).servers === 'object'
      ? ((existingParsed as { servers: Record<string, SundayMcpServer> }).servers as Record<string, SundayMcpServer>)
      : {};

  const fresh: Record<string, SundayMcpServer> = {};
  const already: string[] = [];
  for (const [name, srv] of Object.entries(conversion.servers)) {
    if (name in existingServers) already.push(name);
    else fresh[name] = srv;
  }
  const freshNames = Object.keys(fresh);
  if (freshNames.length === 0) {
    writes.push(skipWrite(target, `MCP servers from ${source.label} already present — skipped.`, 'already-imported'));
  } else {
    const content = `${JSON.stringify({ servers: { ...existingServers, ...fresh } }, null, 2)}\n`;
    writes.push({
      path: target,
      action: existingRaw === null ? 'create' : 'merge',
      summary:
        `Add ${freshNames.length} MCP server(s) from ${source.label} to ${target.replace(home, '~')}` +
        (already.length > 0 ? ` (${already.length} already present: ${already.join(', ')}).` : '.'),
      content,
      preview: content.slice(0, 500),
    });
  }
  attention.push(...mcpSecretAttentionItems(source, conversion));
}

/**
 * Dry-run: detect everything, compute every conversion, write nothing.
 * The returned plan is directly consumable by applyImport().
 */
export async function planImport(opts: ImportOptions): Promise<ImportPlan> {
  const home = opts.homeDir ?? opts.fs.homedir();
  const readFile = (p: string) => opts.fs.readFile(p);
  const detected = await detectImports({ workspaceDir: opts.workspaceDir, homeDir: home, fs: opts.fs, env: opts.env });
  const writes: PlannedWrite[] = [];
  const unconvertible: UnconvertibleItem[] = [];
  const attention: UnconvertibleItem[] = [];

  // Single-file rule sources share ONE AGENTS.md write (batched, idempotent).
  const SINGLE_FILE_RULE_KINDS = new Set([
    'claude-md',
    'gemini-md',
    'cursor-rules-file',
    'windsurf-rules',
    'cline-rules',
  ]);
  const batch = await planAgentsMdBatch(
    detected.filter((d) => SINGLE_FILE_RULE_KINDS.has(d.kind)),
    opts.fs,
    opts.workspaceDir,
  );
  writes.push(...batch.writes);
  unconvertible.push(...batch.unconvertible);

  for (const source of detected) {
    if (SINGLE_FILE_RULE_KINDS.has(source.kind)) continue;
    switch (source.kind) {
      case 'cursor-rules-dir': {
        const plan = await planRuleSource(source, opts.fs, opts.workspaceDir);
        writes.push(...plan.writes);
        unconvertible.push(...plan.unconvertible);
        break;
      }
      case 'vscode-settings':
        await planVscodeSettings(source, opts, home, readFile, writes, unconvertible, attention);
        break;
      case 'vscode-keybindings':
        await planVscodeKeybindings(source, home, readFile, writes, unconvertible, attention);
        break;
      default:
        if (isMcpSource(source.kind)) {
          const raw = await readFile(source.path);
          if (raw === null) break;
          const parsed = parseJson(raw);
          if (parsed === null) {
            unconvertible.push({ source: source.label, item: source.path, reason: 'Invalid JSON — skipped.' });
            break;
          }
          await planMcpMerge(source, parsed, opts, home, readFile, writes, unconvertible, attention);
        }
    }
  }

  // needs-attention items ride along inside `unconvertible` with a marker so
  // the report can split them out; keep the plan type stable.
  const allUnconvertible = [...unconvertible, ...attention.map((a) => ({ ...a, reason: `NEEDS ATTENTION — ${a.reason}` }))];
  return {
    workspaceDir: opts.workspaceDir,
    detected,
    writes,
    unconvertible: allUnconvertible,
    nothingToDo: writes.every((w) => w.action === 'skip'),
  };
}

/**
 * Execute a plan produced by planImport(). Writes go through the injected
 * writeFile (node fs in production, in-memory in tests).
 */
export async function applyImport(
  plan: ImportPlan,
  writeFile: WriteFile,
): Promise<ImportReport> {
  const report: ImportReport = {
    appliedAt: new Date().toISOString(),
    converted: [],
    skipped: [],
    needsAttention: [],
  };
  for (const item of plan.unconvertible) {
    if (item.reason.startsWith('NEEDS ATTENTION — ')) {
      report.needsAttention.push({
        source: item.source,
        item: item.item,
        reason: item.reason.replace(/^NEEDS ATTENTION — /, ''),
      });
    }
  }
  for (const w of plan.writes) {
    if (w.action === 'skip') {
      report.skipped.push({ source: w.path, target: w.path, reason: w.skipReason ?? 'skipped' });
      continue;
    }
    // Derive a friendly source label from the summary.
    await writeFile(w.path, w.content);
    report.converted.push({ source: w.summary, target: w.path, detail: w.action });
  }
  return report;
}
