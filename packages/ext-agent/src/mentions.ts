// sunday-agent — @-mention parsing and expansion for the chat composer.
//
// The webview (packages/ui-chat) only offers @-mention *completion*; the
// actual *expansion* (@file → file contents, @selection → selected text, …)
// happens here in the extension host, which has full `vscode` API access.
//
// Two halves:
//   - `parseMentions(text)` is pure (no vscode) and fully unit-tested.
//   - `expandMentions(mentions, opts)` resolves each mention into a
//     `{ label, content }` context block, best-effort, with per-mention caps.
//
// `composeChatMessage` ties both together for the chatView send path: it
// returns `ContentPart[]` for `chat/send` (which already accepts a parts
// array — no new RPC), with mention context as extra text parts and image
// attachments as image parts.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { ContentPart } from '@sunday/protocol';
import { redactSecrets } from '@sunday/protocol';

// -- mention kinds -----------------------------------------------------------

export type MentionKind =
  | 'file'
  | 'folder'
  | 'symbol'
  | 'selection'
  | 'terminal'
  | 'diagnostics'
  | 'git-diff'
  | 'web'
  | 'docs';

export interface ParsedMention {
  kind: MentionKind;
  /** Exact matched text, e.g. `@file src/index.ts`. */
  raw: string;
  /** Argument (path, symbol name, URL, skill name) — `''` when absent. */
  arg: string;
  /** Offset of the match in the original string. */
  index: number;
}

// -- overflow policy ----------------------------------------------------------

/** Max characters of expanded content per mention. Larger content is
 *  truncated and ends with a handle the model can act on. */
export const MAX_MENTION_CHARS = 4000;
/** Max directory entries listed for `@folder`. */
export const MAX_FOLDER_ENTRIES = 200;
/** Max diagnostics lines listed for `@diagnostics`. */
export const MAX_DIAGNOSTIC_LINES = 100;

/** Truncate `content` to the per-mention cap, appending a handle so the model
 *  knows it can ask the agent to read the rest via its file tools. */
export function truncateMentionContent(label: string, content: string): string {
  if (content.length <= MAX_MENTION_CHARS) return content;
  return (
    content.slice(0, MAX_MENTION_CHARS) +
    `\n…[truncated — ask the agent to read more of ${label}]`
  );
}

// -- parser (pure) -----------------------------------------------------------

/** Ranges of backtick code spans (inline `…` and fenced ```…```) that @-matches
 *  must not be taken from. Best effort: unbalanced backticks are ignored. */
function codeSpanRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

const ARG_KIND_RE =
  /(?<![\w@])@(file|folder|symbol|web|docs)(?![\w-])(?:\(([^)]*)\)|[ \t]+("(?:[^"]*)"|'(?:[^']*)'|[^\s`]+))?/g;
const BARE_KIND_RE = /(?<![\w@])@(selection|terminal|diagnostics|git-diff)(?![\w-])/g;

/**
 * Parse @-mentions out of chat text. Ignores `@` inside backtick code spans
 * (best effort), ignores `user@example.com`-style email addresses, and skips
 * unknown `@foo` kinds. Arguments may be bare (`@file src/a.ts`), quoted
 * (`@file "my dir/a.ts"`), or parenthesized (`@web(https://…)`). Bare kinds
 * (`@selection` etc.) never consume following words as arguments.
 */
export function parseMentions(text: string): ParsedMention[] {
  const masked = codeSpanRanges(text);
  const inCode = (index: number): boolean =>
    masked.some(([s, e]) => index >= s && index < e);
  const out: ParsedMention[] = [];

  ARG_KIND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARG_KIND_RE.exec(text)) !== null) {
    if (inCode(m.index)) continue;
    let arg = (m[2] ?? m[3] ?? '').trim();
    if (
      (arg.startsWith('"') && arg.endsWith('"')) ||
      (arg.startsWith("'") && arg.endsWith("'"))
    ) {
      arg = arg.slice(1, -1);
    }
    out.push({ kind: m[1] as MentionKind, raw: m[0], arg, index: m.index });
  }

  BARE_KIND_RE.lastIndex = 0;
  while ((m = BARE_KIND_RE.exec(text)) !== null) {
    if (inCode(m.index)) continue;
    out.push({ kind: m[1] as MentionKind, raw: m[0], arg: '', index: m.index });
  }

  // Sort by position; when matches overlap (e.g. `@file @selection`, where
  // the arg regex consumed `@selection` as a path), keep the earliest-
  // starting match and drop the ones inside it.
  out.sort((a, b) => a.index - b.index || b.raw.length - a.raw.length);
  const merged: ParsedMention[] = [];
  let end = -1;
  for (const p of out) {
    if (p.index >= end) {
      merged.push(p);
      end = p.index + p.raw.length;
    }
  }
  return merged;
}

// -- expansion (vscode-backed) -----------------------------------------------

export interface ExpandOptions {
  /** Workspace root fallback when no workspace folder is open. */
  workspaceRoot?: string;
}

export interface ContextBlock {
  label: string;
  content: string;
}

function firstWorkspaceRoot(opts?: ExpandOptions): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0]!.uri.fsPath;
  return resolve(opts?.workspaceRoot ?? process.cwd());
}

function resolveMentionPath(arg: string, opts?: ExpandOptions): string {
  return isAbsolute(arg) ? arg : join(firstWorkspaceRoot(opts), arg);
}

function withLineNumbers(text: string): string {
  const lines = text.split('\n');
  // A trailing newline doesn't start a new (empty) numbered line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line, i) => `${i + 1}| ${line}`).join('\n');
}

function block(label: string, content: string): ContextBlock {
  return { label, content: truncateMentionContent(label, content) };
}

async function expandFile(arg: string, opts?: ExpandOptions): Promise<ContextBlock> {
  const label = `@file ${arg || '(missing path)'}`;
  if (!arg) return { label, content: 'No path given. Usage: `@file <relative-or-absolute-path>`.' };
  const uri = vscode.Uri.file(resolveMentionPath(arg, opts));
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return block(label, withLineNumbers(new TextDecoder('utf-8').decode(bytes)));
  } catch (err) {
    return { label, content: `Could not read ${arg}: ${(err as Error).message}` };
  }
}

async function expandFolder(arg: string, opts?: ExpandOptions): Promise<ContextBlock> {
  const label = `@folder ${arg || '(missing path)'}`;
  if (!arg) return { label, content: 'No path given. Usage: `@folder <relative-or-absolute-path>`.' };
  const uri = vscode.Uri.file(resolveMentionPath(arg, opts));
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const names = entries
      .map(([name, type]) => (type === vscode.FileType.Directory ? `${name}/` : name))
      .sort()
      .slice(0, MAX_FOLDER_ENTRIES);
    const more = entries.length > MAX_FOLDER_ENTRIES ? `\n…(${entries.length - MAX_FOLDER_ENTRIES} more)` : '';
    return block(label, names.join('\n') + more);
  } catch (err) {
    return { label, content: `Could not list ${arg}: ${(err as Error).message}` };
  }
}

async function expandSymbol(arg: string, opts?: ExpandOptions): Promise<ContextBlock> {
  const label = `@symbol ${arg || '(missing name)'}`;
  if (!arg) return { label, content: 'No symbol name given. Usage: `@symbol <name>`.' };
  try {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      arg,
    );
    const hit = symbols?.[0];
    if (!hit) return { label, content: `No workspace symbol found for "${arg}".` };
    const loc = hit.location;
    const bytes = await vscode.workspace.fs.readFile(loc.uri);
    const lines = new TextDecoder('utf-8').decode(bytes).split('\n');
    const start = Math.max(0, loc.range.start.line - 10);
    const end = Math.min(lines.length, loc.range.end.line + 11);
    const snippet = lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}| ${line}`)
      .join('\n');
    const file = vscode.workspace.asRelativePath(loc.uri, false);
    return block(label, `${file}:${loc.range.start.line + 1}\n${snippet}`);
  } catch (err) {
    return { label, content: `Symbol lookup failed for "${arg}": ${(err as Error).message}` };
  }
}

async function expandSelection(): Promise<ContextBlock> {
  const label = '@selection';
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return { label, content: 'No active selection in the current editor.' };
  }
  const doc = editor.document;
  const sel = editor.selection;
  const file = vscode.workspace.asRelativePath(doc.uri, false);
  const text = doc.getText(sel);
  return block(label, `${file}:${sel.start.line + 1}-${sel.end.line + 1}\n${text}`);
}

async function expandTerminal(): Promise<ContextBlock> {
  const label = '@terminal';
  const term = vscode.window.activeTerminal;
  if (!term) return { label, content: 'No active terminal.' };
  // The stable VS Code API does not expose terminal scrollback output; only
  // metadata is available here. The agent can re-run commands via its shell
  // tools if it needs the actual output.
  // creationOptions is TerminalOptions | ExtensionTerminalOptions; only the
  // former carries cwd, and it may be a string or a Uri.
  const rawCwd = (term.creationOptions as { cwd?: unknown }).cwd;
  const cwdPath = typeof rawCwd === 'string' ? rawCwd : '';
  const lines = [
    `Terminal: ${term.name}`,
    `processId: ${await term.processId}`,
    `cwd: ${cwdPath ? vscode.workspace.asRelativePath(vscode.Uri.file(cwdPath), false) : '(unknown)'}`,
    '',
    'Note: the VS Code extension API does not expose terminal output text,',
    'so only metadata is included. Re-run the command via the agent\u2019s',
    'shell tools if the output is needed.',
  ];
  return { label, content: lines.join('\n') };
}

async function expandDiagnostics(): Promise<ContextBlock> {
  const label = '@diagnostics';
  const all = vscode.languages.getDiagnostics();
  const lines: string[] = [];
  for (const [uri, diags] of all) {
    if (lines.length >= MAX_DIAGNOSTIC_LINES) break;
    const file = vscode.workspace.asRelativePath(uri, false);
    for (const d of diags) {
      if (lines.length >= MAX_DIAGNOSTIC_LINES) break;
      const sev = vscode.DiagnosticSeverity[d.severity] ?? d.severity;
      lines.push(
        `${file}:${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}] ${d.message}`,
      );
    }
  }
  if (!lines.length) return { label, content: 'No problems reported in the workspace.' };
  const more =
    all.reduce((n, [, ds]) => n + ds.length, 0) > MAX_DIAGNOSTIC_LINES
      ? '\n…(more problems omitted)'
      : '';
  return block(label, lines.join('\n') + more);
}

function gitDiff(cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // `git diff HEAD` covers staged + unstaged in one shot.
    execFile('git', ['diff', 'HEAD', '--stat', '--', '.'], { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return rejectPromise(err);
      execFile(
        'git',
        ['diff', 'HEAD', '--', '.'],
        { cwd, maxBuffer: 16 * 1024 * 1024 },
        (err2, stdout2) => (err2 ? rejectPromise(err2) : resolvePromise(`${stdout}\n${stdout2}`)),
      );
    });
  });
}

async function expandGitDiff(opts?: ExpandOptions): Promise<ContextBlock> {
  const label = '@git-diff';
  try {
    const diff = await gitDiff(firstWorkspaceRoot(opts));
    if (!diff.trim()) return { label, content: 'No changes (working tree clean against HEAD).' };
    return block(label, diff);
  } catch (err) {
    return { label, content: `Could not run git diff: ${(err as Error).message}` };
  }
}

function expandWeb(arg: string): ContextBlock {
  const label = `@web ${arg || '(missing url)'}`;
  if (!arg) {
    return { label, content: 'No URL given. Usage: `@web <https://…>`.' };
  }
  // Deliberately not fetched in the extension host: the agent has browser
  // tools (browserd) and can fetch or search it itself.
  return {
    label,
    content: `URL reference: ${arg}\n(The extension did not fetch this page; use the agent's browser tools to read it.)`,
  };
}

/**
 * Resolve `@docs <name>` to `<workspace>/.sunday/skills/<name>/SKILL.md`
 * (workspace scope first), falling back to `~/.sunday/skills/<name>/SKILL.md`.
 * Reads the SKILL.md by directory convention rather than through
 * @sunday/skills, so this module adds no new workspace dependency. A tiny
 * frontmatter scan pulls `name:`/`description:` for the block header.
 */
async function expandDocs(arg: string, opts?: ExpandOptions): Promise<ContextBlock> {
  const label = `@docs ${arg || '(missing name)'}`;
  if (!arg) return { label, content: 'No skill name given. Usage: `@docs <skill-name>`.' };
  const candidates = [
    join(firstWorkspaceRoot(opts), '.sunday', 'skills', arg, 'SKILL.md'),
    join(homedir(), '.sunday', 'skills', arg, 'SKILL.md'),
  ];
  for (const file of candidates) {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      const text = new TextDecoder('utf-8').decode(raw);
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      const name = fm?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? arg;
      const description = fm?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
      const body = fm ? text.slice(fm[0].length) : text;
      const header = description ? `${name} — ${description}` : name;
      return block(label, `${header}\n${body}`);
    } catch {
      /* try the next candidate */
    }
  }
  return {
    label,
    content: `Skill "${arg}" not found in .sunday/skills (workspace) or ~/.sunday/skills (user).`,
  };
}

/**
 * Expand a list of parsed mentions into context blocks. Mentions are
 * deduplicated by kind+arg so a repeated `@file x` is read once. Failures
 * produce a descriptive block rather than throwing.
 */
export async function expandMentions(
  mentions: ParsedMention[],
  opts?: ExpandOptions,
): Promise<ContextBlock[]> {
  const seen = new Set<string>();
  const blocks: ContextBlock[] = [];
  for (const m of mentions) {
    const key = `${m.kind}:${m.arg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    switch (m.kind) {
      case 'file':
        blocks.push(await expandFile(m.arg, opts));
        break;
      case 'folder':
        blocks.push(await expandFolder(m.arg, opts));
        break;
      case 'symbol':
        blocks.push(await expandSymbol(m.arg, opts));
        break;
      case 'selection':
        blocks.push(await expandSelection());
        break;
      case 'terminal':
        blocks.push(await expandTerminal());
        break;
      case 'diagnostics':
        blocks.push(await expandDiagnostics());
        break;
      case 'git-diff':
        blocks.push(await expandGitDiff(opts));
        break;
      case 'web':
        blocks.push(expandWeb(m.arg));
        break;
      case 'docs':
        blocks.push(await expandDocs(m.arg, opts));
        break;
    }
  }
  return blocks;
}

export interface ImageAttachment {
  /** Fully-prefixed data: URL (e.g. `data:image/jpeg;base64,…`). */
  dataUrl: string;
}

/**
 * Build the `chat/send` message for a composer send: the raw user text, plus
 * one extra text part carrying the expanded @-mention context, plus image
 * parts for pasted attachments. Uses the existing parts-array shape of
 * `chat/send` — no new RPC.
 */
export async function composeChatMessage(
  text: string,
  images: ImageAttachment[],
  opts?: ExpandOptions,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  // S6: redact secret shapes from ALL outbound prompt content before it
  // reaches the provider (user text + @-mention expansions).
  if (text) parts.push({ type: 'text', text: redactSecrets(text) });
  const mentions = parseMentions(text);
  if (mentions.length > 0) {
    const blocks = await expandMentions(mentions, opts);
    const ctx = blocks.map((b) => `--- context: ${b.label} ---\n${redactSecrets(b.content)}`).join('\n\n');
    parts.push({
      type: 'text',
      text: `The user's message references the following @-mentions (resolved below):\n${ctx}`,
    });
  }
  for (const img of images) {
    if (img.dataUrl) parts.push({ type: 'image', dataUrl: img.dataUrl });
  }
  // Keep the parts array non-empty so `chat/send` params always validate.
  if (parts.length === 0) parts.push({ type: 'text', text: '' });
  return parts;
}
