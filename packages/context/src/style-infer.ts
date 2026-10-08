/**
 * @sunday/context — project style inference (Group B2).
 *
 * Analyzes a sample of a repository's source files to detect its code
 * style: indent (tabs/spaces + size), quote style, semicolons, trailing
 * commas, identifier naming conventions, and module system (ESM/CJS).
 *
 * The result is stored per project in `~/.sunday/styles/<project-hash>.json`
 * (hash = sha1 of the workspace root path, 16 chars) and injected into the
 * session system prompt as a one-line summary. Inference auto-runs once per
 * project on the first session (when no stored file exists); the
 * `sunday.style.infer` command re-runs it manually.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { sundayHome } from './indexer.js';

/** Max files sampled per inference run. */
export const MAX_STYLE_FILES = 50;
/** Total bytes of source read per inference run. */
export const MAX_STYLE_BYTES_TOTAL = 200 * 1024;
/** Directories never descended into. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  '.next', '.venv', 'venv', '__pycache__', 'target', 'vendor', '.idea', '.vscode',
]);

export type IndentKind = 'tabs' | 'spaces' | 'mixed' | 'unknown';
export type QuoteStyle = 'single' | 'double' | 'mixed' | 'unknown';
export type SemicolonStyle = 'always' | 'never' | 'mixed' | 'unknown';
export type TrailingCommaStyle = 'always' | 'never' | 'mixed' | 'unknown';
export type ImportStyle = 'esm' | 'cjs' | 'mixed' | 'unknown';

export interface ProjectStyle {
  indent: { kind: IndentKind; size: number | null };
  quotes: QuoteStyle;
  semicolons: SemicolonStyle;
  trailingCommas: TrailingCommaStyle;
  /** Identifier counts per convention. */
  naming: { camelCase: number; snake_case: number; PascalCase: number };
  imports: ImportStyle;
}

/** Env var the extension stamps to disable style auto-inference ('0' = off). */
export const STYLE_AUTOINFER_ENV = 'SUNDAY_STYLE_AUTOINFER';

/** Stable 16-char project id: sha1 of the resolved workspace root path. */
export function projectIdFor(workspaceRoot: string): string {
  return createHash('sha1').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 16);
}

/** Style file for a workspace root: `~/.sunday/styles/<project-hash>.json`. */
export function styleFilePath(workspaceRoot: string): string {
  return path.join(sundayHome(), 'styles', `${projectIdFor(workspaceRoot)}.json`);
}

/** Load the stored style, or null when missing/corrupt/for another root. */
export function loadStoredStyle(workspaceRoot: string): ProjectStyle | null {
  let raw: string;
  try {
    raw = fs.readFileSync(styleFilePath(workspaceRoot), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { root?: string; style?: ProjectStyle };
    if (parsed?.root !== path.resolve(workspaceRoot) || !parsed?.style) return null;
    return parsed.style;
  } catch {
    return null;
  }
}

/** Persist an inferred style for the workspace root. */
export function saveStyle(workspaceRoot: string, style: ProjectStyle): void {
  const file = styleFilePath(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ root: path.resolve(workspaceRoot), style, inferredAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

interface StyleAccumulator {
  tabIndented: number;
  spaceIndented: number;
  /** Leading-space widths of space-indented lines. */
  spaceWidths: number[];
  singleQuotes: number;
  doubleQuotes: number;
  semiEnd: number;
  noSemiEnd: number;
  trailingComma: number;
  noTrailingComma: number;
  camelCase: number;
  snakeCase: number;
  pascalCase: number;
  esm: number;
  cjs: number;
}

function newAccumulator(): StyleAccumulator {
  return {
    tabIndented: 0, spaceIndented: 0, spaceWidths: [],
    singleQuotes: 0, doubleQuotes: 0,
    semiEnd: 0, noSemiEnd: 0,
    trailingComma: 0, noTrailingComma: 0,
    camelCase: 0, snakeCase: 0, pascalCase: 0,
    esm: 0, cjs: 0,
  };
}

const CAMEL_RE = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g;
const SNAKE_RE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g;
const PASCAL_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
const STRING_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** True when the buffer looks like binary (NUL byte in the head). */
function isBinary(head: Buffer): boolean {
  return head.includes(0);
}

/** Collect up to MAX_STYLE_FILES text files, bounded by total bytes. */
function sampleFiles(workspaceRoot: string): string[] {
  const root = path.resolve(workspaceRoot);
  const out: string[] = [];
  let bytesLeft = MAX_STYLE_BYTES_TOTAL;
  let visited = 0;
  const MAX_VISITED = 5000;

  const walk = (dir: string): void => {
    if (out.length >= MAX_STYLE_FILES || bytesLeft <= 0 || visited > MAX_VISITED) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_STYLE_FILES || bytesLeft <= 0 || visited > MAX_VISITED) return;
      visited++;
      if (e.name.startsWith('.') && e.name !== '.') {
        // Keep scanning dotfiles like .eslintrc, but skip dot-directories.
        if (e.isDirectory()) continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.isSymbolicLink()) continue;
        walk(full);
      } else if (e.isFile()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size === 0 || stat.size > 512 * 1024) continue;
        const take = Math.min(stat.size, bytesLeft);
        let fd: number;
        try {
          fd = fs.openSync(full, 'r');
        } catch {
          continue;
        }
        try {
          const head = Buffer.alloc(Math.min(8192, take));
          fs.readSync(fd, head, 0, head.length, 0);
          if (isBinary(head)) continue;
          out.push(full);
          bytesLeft -= take;
        } catch {
          // unreadable: skip
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  };
  walk(root);
  return out;
}

function analyzeText(text: string, acc: StyleAccumulator): void {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.match(/^[ \t]*/)?.[0] ?? '';
    if (indent.includes('\t')) acc.tabIndented++;
    else if (indent.length > 0) {
      acc.spaceIndented++;
      acc.spaceWidths.push(indent.length);
    }

    const code = line.replace(STRING_RE, '""');
    // Quotes: count in the original line (strings carry the signal).
    acc.singleQuotes += (line.match(/'/g) ?? []).length;
    acc.doubleQuotes += (line.match(/"/g) ?? []).length;

    // Semicolons: statement-ending lines.
    const trimmed = code.trim();
    if (/[;}]$/.test(trimmed) && !/[{}]$/.test(trimmed)) {
      if (trimmed.endsWith(';')) acc.semiEnd++;
    } else if (/[)\w\]]$/.test(trimmed) && !/^(import|export|from|#|\/\/)/.test(trimmed)) {
      acc.noSemiEnd++;
    }

    // Import style.
    if (/^\s*import\s+[^'"]*from\s*['"]|^\s*import\s*['"]/.test(line)) acc.esm++;
    if (/\brequire\s*\(/.test(code)) acc.cjs++;

    // Naming conventions (identifiers outside string literals).
    acc.camelCase += (code.match(CAMEL_RE) ?? []).length;
    acc.snakeCase += (code.match(SNAKE_RE) ?? []).length;
    acc.pascalCase += (code.match(PASCAL_RE) ?? []).length;
  }

  // Trailing commas: `,\n  }` vs `\n  }` (multiline closers).
  acc.trailingComma += (text.match(/,\r?\n\s*[}\]]/g) ?? []).length;
  acc.noTrailingComma += (text.match(/[^\s,]\r?\n\s*[}\]]/g) ?? []).length;
}

/** Majority vote with a 2:1 margin, else 'mixed'/'unknown'. */
function vote(a: number, b: number, aVal: string, bVal: string, mixed: string): string {
  if (a === 0 && b === 0) return 'unknown';
  if (a >= 2 * b && a > 0) return aVal;
  if (b >= 2 * a && b > 0) return bVal;
  return mixed;
}

function modeOfWidth(widths: number[]): number | null {
  if (widths.length === 0) return null;
  const counts = new Map<number, number>();
  for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [w, c] of counts) {
    if (w >= 1 && w <= 8 && c > bestCount) {
      best = w;
      bestCount = c;
    }
  }
  return best;
}

/** Infer the project's code style. Never throws — returns unknowns on failure. */
export function inferStyle(workspaceRoot: string): ProjectStyle {
  const acc = newAccumulator();
  try {
    for (const file of sampleFiles(workspaceRoot)) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      analyzeText(text, acc);
    }
  } catch {
    // fall through to unknowns
  }

  const indentKind = vote(acc.tabIndented, acc.spaceIndented, 'tabs', 'spaces', 'mixed') as IndentKind;
  return {
    indent: {
      kind: indentKind,
      size: indentKind === 'spaces' ? modeOfWidth(acc.spaceWidths) : null,
    },
    quotes: vote(acc.singleQuotes, acc.doubleQuotes, 'single', 'double', 'mixed') as QuoteStyle,
    semicolons: vote(acc.semiEnd, acc.noSemiEnd, 'always', 'never', 'mixed') as SemicolonStyle,
    trailingCommas: vote(acc.trailingComma, acc.noTrailingComma, 'always', 'never', 'mixed') as TrailingCommaStyle,
    naming: { camelCase: acc.camelCase, snake_case: acc.snakeCase, PascalCase: acc.pascalCase },
    imports: vote(acc.esm, acc.cjs, 'esm', 'cjs', 'mixed') as ImportStyle,
  };
}

/** Dominant naming convention, or null when nothing was observed. */
export function dominantNaming(naming: ProjectStyle['naming']): string | null {
  const entries: Array<[string, number]> = [
    ['camelCase', naming.camelCase],
    ['snake_case', naming.snake_case],
    ['PascalCase', naming.PascalCase],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]![1] > 0 ? entries[0]![0] : null;
}

/**
 * One-line summary for the system prompt, e.g.
 * "This project uses 2-space indent, single quotes, semicolons, trailing
 * commas, camelCase identifiers, and ESM imports."
 */
export function formatStyleForPrompt(style: ProjectStyle): string {
  const parts: string[] = [];
  if (style.indent.kind === 'spaces' && style.indent.size) {
    parts.push(`${style.indent.size}-space indent`);
  } else if (style.indent.kind === 'tabs') {
    parts.push('tab indent');
  } else if (style.indent.kind === 'mixed') {
    parts.push('mixed indent');
  }
  if (style.quotes === 'single') parts.push('single quotes');
  else if (style.quotes === 'double') parts.push('double quotes');
  if (style.semicolons === 'always') parts.push('semicolons');
  else if (style.semicolons === 'never') parts.push('no semicolons');
  if (style.trailingCommas === 'always') parts.push('trailing commas');
  else if (style.trailingCommas === 'never') parts.push('no trailing commas');
  const naming = dominantNaming(style.naming);
  if (naming) parts.push(`${naming} identifiers`);
  if (style.imports === 'esm') parts.push('ESM imports');
  else if (style.imports === 'cjs') parts.push('CommonJS requires');

  if (parts.length === 0) return 'No strong code-style signal was detected for this project.';
  return `This project uses ${parts.join(', ')}.`;
}
