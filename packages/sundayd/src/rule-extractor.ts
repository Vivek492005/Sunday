/**
 * Rule extractor — the learning loop of the self-improving agent.
 *
 * When the user corrects the agent ("no, use pnpm instead of npm"),
 * `detectCorrection` spots the correction heuristically and `extractRule`
 * converts it into an imperative rule string. `RuleStore` persists learned
 * rules in `<home>/.sunday/rules.md` (one `- [id] rule` line per rule, with
 * an HTML-comment metadata suffix), and `rulesToPrompt` renders the stored
 * rules as a system-prompt section so future turns respect them.
 *
 * The markdown format here is shared with the ext-agent sidebar
 * (`packages/ext-agent/src/rulesView.ts`), which reads/writes the same
 * file directly. Keep the line format in sync: `- [<id>] <rule>`.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A rule learned from a user correction. */
export interface LearnedRule {
  /** Stable id (uuid). */
  id: string;
  /** Imperative rule text, e.g. "Always use pnpm instead of npm." */
  rule: string;
  /** ISO-8601 timestamp of when the rule was learned. */
  createdAt: string;
  /** Where the rule came from. Only user corrections exist today. */
  source: 'correction';
  /** Project the rule was learned in ('' = global). */
  project: string;
}

export interface CorrectionDetection {
  /** True when the message looks like a correction of the agent. */
  isCorrection: boolean;
  /** Heuristic confidence in [0, 1]. */
  confidence: number;
}

/**
 * Correction markers that almost always open a correction when they start
 * the message ("no, ...", "actually, ...", "wrong, ...").
 */
const LEADING_CORRECTION =
  /^\s*(no|nope|nah|wrong|incorrect|not quite|not exactly|actually|instead|stop|hold on|wait)\s*[,.:;!?]?\s+/i;

/**
 * Heuristically decide whether a user message corrects the agent's previous
 * action. Scores independent signals and thresholds the total at 0.5.
 *
 * @param userMessage the raw user message.
 * @param previousAgentAction what the agent did just before (summary); when
 *   given, deictic words ("that", "it") referencing it add a small boost.
 */
export function detectCorrection(
  userMessage: string,
  previousAgentAction?: string,
): CorrectionDetection {
  const msg = userMessage ?? '';
  let score = 0;

  if (LEADING_CORRECTION.test(msg)) score += 0.6;
  // "do X instead" / "use X instead of Y" — the canonical correction shape.
  if (/\binstead\b/i.test(msg)) score += 0.55;
  // "I said ..." contradicts what the agent just did.
  if (/\bi said\b/i.test(msg)) score += 0.5;
  // Directives: "don't run tests in parallel", "never commit directly".
  if (/^\s*(please\s+)?(don't|do not|never)\b/i.test(msg)) {
    score += 0.55;
  } else if (/\b(don't|do not)\b/i.test(msg)) {
    score += 0.3;
  }
  // "you should have ..." points at a past mistake.
  if (/\bshould have\b|\bshould've\b/i.test(msg)) score += 0.5;
  // "that's not what I asked", "not how we do it".
  if (/\bthat's (not|wrong)\b|\bnot (what|how)\b/i.test(msg)) score += 0.5;
  // Bare "wrong" anywhere is a weaker signal than a leading "wrong,".
  if (/\bwrong\b/i.test(msg) && !LEADING_CORRECTION.test(msg)) score += 0.2;

  // Deictic reference to the agent's last action ("do it like that").
  if (previousAgentAction && /\b(that|it|this)\b/i.test(msg)) score += 0.15;

  const confidence = Math.min(1, Math.round(score * 100) / 100);
  return { isCorrection: confidence >= 0.5, confidence };
}

/** Correction-marker words stripped before template matching. */
const LEADING_MARKER =
  /^\s*(no|nope|nah|wrong|incorrect|not quite|not exactly|actually|instead|stop|hold on|wait)\b\s*[,.:;!]?\s*/i;

function stripMarkers(message: string): string {
  let m = message.trim();
  for (let i = 0; i < 3; i++) {
    const next = m.replace(LEADING_MARKER, '');
    if (next === m) break;
    m = next;
  }
  return m.trim();
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function withPeriod(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Convert a user correction into an imperative rule string.
 *
 * Templates (checked in order):
 * - "use X instead of Y" → "Always use X instead of Y."
 * - "don't <do X>" / "do not <do X>" → "Never <do X>."
 * - "never <do X>" → "Never <do X>."
 * - "always <do X>" → "Always <do X>."
 * - fallback → "User preference: <cleaned message>."
 *
 * @param context optional scope suffix appended before the final period,
 *   e.g. "for package commands".
 * @returns the rule string, or null when nothing extractable remains
 *   (e.g. a bare "no").
 */
export function extractRule(userMessage: string, context?: string): string | null {
  const cleaned = stripMarkers(userMessage ?? '').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 4 || !/[a-z]/i.test(cleaned)) return null;

  const scope = context?.trim().replace(/[.!]\s*$/, '') ?? '';
  const scoped = (rule: string): string => {
    const withScope = scope ? `${rule.replace(/[.!]\s*$/, '')} ${scope}` : rule;
    return withPeriod(withScope);
  };

  // "use pnpm instead of npm" → "Always use pnpm instead of npm."
  const instead = cleaned.match(/^use\s+(.+?)\s+instead of\s+(.+?)\s*$/i);
  if (instead) {
    return scoped(`Always use ${instead[1]!.trim()} instead of ${instead[2]!.trim()}`);
  }

  // "don't run tests in parallel" → "Never run tests in parallel."
  // The "Never" prefix already carries the capital; the remainder keeps its
  // original casing.
  const dont = cleaned.match(/^(?:please\s+)?don'?t\s+(.+?)\s*$/i) ?? cleaned.match(/^do not\s+(.+?)\s*$/i);
  if (dont) {
    return scoped(`Never ${dont[1]!.trim()}`);
  }

  // "never commit directly" → "Never commit directly."
  const never = cleaned.match(/^never\s+(.+?)\s*$/i);
  if (never) {
    return scoped(`Never ${never[1]!.trim()}`);
  }

  // "always sign your commits" → "Always sign your commits."
  const always = cleaned.match(/^always\s+(.+?)\s*$/i);
  if (always) {
    return scoped(`Always ${always[1]!.trim()}`);
  }

  return scoped(`User preference: ${capitalize(cleaned)}`);
}

/** Markdown line: `- [<id>] <rule> <!-- createdAt=<iso> source=correction project=<p> -->` */
const RULE_LINE = /^- \[(?<id>[^\]]+)\] (?<rest>.*)$/;
const META_SUFFIX = /\s*<!--\s*(?<meta>.*?)\s*-->\s*$/;

function parseMeta(meta: string): { createdAt: string; source: string; project: string } {
  const out = { createdAt: '', source: 'correction', project: '' };
  for (const part of meta.split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 'createdAt') out.createdAt = value;
    else if (key === 'source') out.source = value;
    else if (key === 'project') out.project = value;
  }
  return out;
}

function formatLine(rule: LearnedRule): string {
  const oneLine = rule.rule.replace(/\s+/g, ' ').trim();
  const meta = `createdAt=${rule.createdAt} source=${rule.source} project=${rule.project}`;
  return `- [${rule.id}] ${oneLine} <!-- ${meta} -->`;
}

function parseLine(line: string): LearnedRule | null {
  const m = RULE_LINE.exec(line.trim());
  if (!m || !m.groups) return null;
  const id = m.groups['id']!.trim();
  let rest = m.groups['rest'] ?? '';
  let createdAt = '';
  let project = '';
  const metaMatch = META_SUFFIX.exec(rest);
  if (metaMatch?.groups) {
    const meta = parseMeta(metaMatch.groups['meta'] ?? '');
    createdAt = meta.createdAt;
    project = meta.project;
    rest = rest.slice(0, metaMatch.index).trimEnd();
  }
  if (!id || !rest) return null;
  return { id, rule: rest, createdAt, source: 'correction', project };
}

/**
 * File-backed store for learned rules. Persists to
 * `<home>/.sunday/rules.md` so the daemon (sundayd) and the extension
 * share one source of truth via the on-disk format.
 */
export class RuleStore {
  private readonly filePath: string;

  constructor(opts: { homeDir?: string } = {}) {
    this.filePath = join(opts.homeDir ?? homedir(), '.sunday', 'rules.md');
  }

  /** The backing file path (useful for debugging/logging). */
  get path(): string {
    return this.filePath;
  }

  /** Append a rule. Returns the stored record (with generated id). */
  async add(rule: string, project = ''): Promise<LearnedRule> {
    const record: LearnedRule = {
      id: randomUUID(),
      rule: rule.replace(/\s+/g, ' ').trim(),
      createdAt: new Date().toISOString(),
      source: 'correction',
      project,
    };
    const existing = await this.list();
    existing.push(record);
    await mkdir(join(this.filePath, '..'), { recursive: true });
    await writeFile(this.filePath, existing.map(formatLine).join('\n') + '\n', 'utf8');
    return record;
  }

  /** All stored rules, oldest first. Empty when the file does not exist. */
  async list(): Promise<LearnedRule[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: LearnedRule[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** Delete a rule by id. Returns true when a rule was removed. */
  async remove(id: string): Promise<boolean> {
    const rules = await this.list();
    const kept = rules.filter((r) => r.id !== id);
    if (kept.length === rules.length) return false;
    await writeFile(this.filePath, kept.map(formatLine).join('\n') + (kept.length ? '\n' : ''), 'utf8');
    return true;
  }
}

/**
 * Render learned rules as a system-prompt section. Returns an empty string
 * when there are no rules so callers can skip injection.
 */
export function rulesToPrompt(rules: LearnedRule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map((r) => `- ${r.rule.replace(/\s+/g, ' ').trim()}`);
  return `Learned rules (from your corrections):\n${lines.join('\n')}`;
}
