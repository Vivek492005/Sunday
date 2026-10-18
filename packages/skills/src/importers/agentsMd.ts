/**
 * Converters for foreign rule markdown files → Sunday canonical formats.
 *
 *  - Single files (CLAUDE.md, GEMINI.md, .cursorrules, .windsurfrules,
 *    .clinerules) are appended to `<workspace>/AGENTS.md` inside a marked
 *    import block. The block carries a content hash, so re-running the
 *    importer is idempotent: an identical source is skipped, a changed
 *    source appends a new block (the old one stays for manual cleanup).
 *  - `.cursor/rules/*.md|*.mdc` become individual
 *    `<workspace>/.sunday/rules/<name>.md` files, preserving Cursor
 *    frontmatter (description/globs) and adding an `imported-from` key.
 */
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import type { FsLike } from './fs.js';
import type {
  DetectedSource,
  PlannedWrite,
  UnconvertibleItem,
} from './types.js';

export function hashContent(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 12);
}

const MARKER_OPEN = (kind: string, hash: string) => `<!-- sunday-import:${kind}:${hash} -->`;
const MARKER_CLOSE = '<!-- /sunday-import -->';

const SINGLE_FILE_KINDS = new Set(['claude-md', 'gemini-md', 'cursor-rules-file', 'windsurf-rules', 'cline-rules']);

function agentsMdHeader(): string {
  return (
    '# AGENTS.md\n\n' +
    '> Project instructions for the Sunday agent.\n' +
    '>\n' +
    '> Sections marked `sunday-import` below were converted from other AI\n' +
    '> coding tools — review and trim them as the project evolves.\n'
  );
}

function importBlock(source: DetectedSource, hash: string, body: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return (
    `\n${MARKER_OPEN(source.kind, hash)}\n` +
    `## Imported from ${source.label} (${date})\n\n` +
    `${body.trim()}\n\n` +
    `${MARKER_CLOSE}\n`
  );
}

export interface RulePlan {
  writes: PlannedWrite[];
  unconvertible: UnconvertibleItem[];
}

/** Plan the import of a single rule markdown file into AGENTS.md. */
export async function planSingleRuleFile(
  source: DetectedSource,
  fs: FsLike,
  workspaceDir: string,
  readFile: (path: string) => Promise<string | null> = (p) => fs.readFile(p),
): Promise<RulePlan> {
  const writes: PlannedWrite[] = [];
  const unconvertible: UnconvertibleItem[] = [];
  const target = join(workspaceDir, 'AGENTS.md');

  const raw = await readFile(source.path);
  if (raw === null) {
    return { writes, unconvertible };
  }
  if (raw.trim().length === 0) {
    unconvertible.push({ source: source.label, item: source.path, reason: 'File is empty — nothing to import.' });
    return { writes, unconvertible };
  }

  const hash = hashContent(raw);
  const existing = (await readFile(target)) ?? '';
  if (existing.includes(MARKER_OPEN(source.kind, hash))) {
    writes.push({
      path: target,
      action: 'skip',
      summary: `AGENTS.md already contains the import of ${source.label} — skipped.`,
      content: '',
      preview: '',
      skipReason: 'already-imported',
    });
    return { writes, unconvertible };
  }

  const block = importBlock(source, hash, raw);
  const isNew = existing.length === 0;
  const full = isNew ? `${agentsMdHeader()}${block}` : `${existing.replace(/\n?$/, '\n')}${block}`;
  writes.push({
    path: target,
    action: isNew ? 'create' : 'append',
    summary: isNew
      ? `Create AGENTS.md with import of ${source.label} (${raw.trim().split('\n').length} lines).`
      : `Append import of ${source.label} to AGENTS.md (${raw.trim().split('\n').length} lines).`,
    content: full,
    preview: full.slice(0, 500),
  });
  return { writes, unconvertible };
}

/** Sanitize a rule file name for `.sunday/rules/`. */
function ruleTargetName(fileName: string): string {
  const base = basename(fileName).replace(/\.(mdc|md)$/i, '');
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${clean || 'rule'}.md`;
}

/** Plan the import of a `.cursor/rules/` directory into `.sunday/rules/`. */
export async function planCursorRulesDir(
  source: DetectedSource,
  fs: FsLike,
  workspaceDir: string,
  readFile: (path: string) => Promise<string | null> = (p) => fs.readFile(p),
): Promise<RulePlan> {
  const writes: PlannedWrite[] = [];
  const unconvertible: UnconvertibleItem[] = [];

  const entries = (await fs.readdir(source.path)) ?? [];
  const ruleFiles = entries.filter((e) => e.endsWith('.md') || e.endsWith('.mdc')).sort();
  if (ruleFiles.length === 0) {
    unconvertible.push({ source: source.label, item: source.path, reason: 'No .md/.mdc rule files found.' });
    return { writes, unconvertible };
  }

  for (const file of ruleFiles) {
    const abs = join(source.path, file);
    const raw = await readFile(abs);
    if (raw === null || raw.trim().length === 0) {
      unconvertible.push({ source: source.label, item: abs, reason: 'Unreadable or empty — skipped.' });
      continue;
    }
    const { data, body } = parseFrontmatter(raw);
    const targetName = ruleTargetName(file);
    const target = join(workspaceDir, '.sunday', 'rules', targetName);
    const marker = MARKER_OPEN('cursor-rules-dir', hashContent(raw));
    const existing = await readFile(target);
    if (existing !== null && existing.includes(marker)) {
      writes.push({
        path: target,
        action: 'skip',
        summary: `${targetName} already imported — skipped.`,
        content: '',
        preview: '',
        skipReason: 'already-imported',
      });
      continue;
    }
    if (existing !== null && !existing.includes('sunday-import:')) {
      unconvertible.push({
        source: source.label,
        item: target,
        reason: `A hand-written rule already exists at ${targetName} — left untouched (manual merge needed).`,
      });
      continue;
    }
    const merged: Record<string, string> = { 'imported-from': `.cursor/rules/${file}` };
    for (const [k, v] of Object.entries(data)) {
      merged[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    const fm = Object.entries(merged)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const content = `---\n${fm}\n---\n${marker}\n\n${body.trim()}\n\n${MARKER_CLOSE}\n`;
    writes.push({
      path: target,
      action: 'create',
      summary: `Create .sunday/rules/${targetName} from .cursor/rules/${file}.`,
      content,
      preview: content.slice(0, 500),
    });
  }
  return { writes, unconvertible };
}

/**
 * Batch planner for single-file rule sources → ONE AGENTS.md write.
 *
 * Planning each file independently would produce N competing "create
 * AGENTS.md" writes where the last one clobbers the rest. Instead we read
 * the existing file once, skip sources whose import marker is already
 * present (idempotency), and append all new blocks in a single write.
 */
export async function planAgentsMdBatch(
  sources: DetectedSource[],
  fs: FsLike,
  workspaceDir: string,
): Promise<RulePlan> {
  const writes: PlannedWrite[] = [];
  const unconvertible: UnconvertibleItem[] = [];
  const target = join(workspaceDir, 'AGENTS.md');
  const readFile = (p: string) => fs.readFile(p);

  const existing = (await readFile(target)) ?? '';
  const isNew = existing.length === 0;
  let combined = isNew ? agentsMdHeader() : existing.replace(/\n?$/, '\n');
  const addedLabels: string[] = [];

  for (const source of sources) {
    const raw = await readFile(source.path);
    if (raw === null) continue;
    if (raw.trim().length === 0) {
      unconvertible.push({
        source: source.label,
        item: source.path,
        reason: 'File is empty — nothing to import.',
      });
      continue;
    }
    const hash = hashContent(raw);
    const haystack = isNew ? combined : existing;
    if (haystack.includes(MARKER_OPEN(source.kind, hash))) {
      writes.push({
        path: target,
        action: 'skip',
        summary: `AGENTS.md already contains the import of ${source.label} — skipped.`,
        content: '',
        preview: '',
        skipReason: 'already-imported',
      });
      continue;
    }
    combined += importBlock(source, hash, raw);
    addedLabels.push(source.label);
  }

  if (addedLabels.length > 0) {
    writes.push({
      path: target,
      action: isNew ? 'create' : 'append',
      summary: `${isNew ? 'Create' : 'Update'} AGENTS.md with import(s) of ${addedLabels.join(', ')}.`,
      content: combined,
      preview: combined.slice(0, 500),
    });
  }
  return { writes, unconvertible };
}

/** Route a detected rule source to the right planner. */
export async function planRuleSource(
  source: DetectedSource,
  fs: FsLike,
  workspaceDir: string,
): Promise<RulePlan> {
  if (source.kind === 'cursor-rules-dir') {
    return planCursorRulesDir(source, fs, workspaceDir);
  }
  if (SINGLE_FILE_KINDS.has(source.kind)) {
    return planSingleRuleFile(source, fs, workspaceDir);
  }
  return { writes: [], unconvertible: [] };
}
