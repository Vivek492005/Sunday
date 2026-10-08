/**
 * Second Brain — structured long-term memory for the SUNDAY agent.
 *
 * Complements the free-form markdown memory (`memory.ts`): memories are
 * stored as structured JSONL records under `<home>/.sunday/memory/` so they
 * can be searched, tagged, and injected into prompts by relevance.
 *
 * Every write goes through `assertNoSecrets()` from `./memory.js` — secret
 * refusal is a load-bearing guarantee shared by both memory systems, not
 * duplicated here.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SecretRefusedError, assertNoSecrets } from './memory.js';

/** A single structured long-term memory record. */
export interface LongTermMemory {
  /** Random UUID assigned at save time. */
  id: string;
  /** The memory text. Never contains secrets — refused at save time. */
  text: string;
  /** Save time, ISO 8601 UTC. */
  timestamp: string;
  /** Project the memory belongs to (e.g. the workspace folder name). */
  project: string;
  /** Classification tags, e.g. `['decision']`, `['preference']`, `['bugfix']`. */
  tags: string[];
  /** `'auto'` for heuristic extraction, `'manual'` for user-authored. */
  source: 'auto' | 'manual';
}

export interface MemoryStoreOptions {
  /** Home dir whose `.sunday/memory/` holds the store. Defaults to `os.homedir()`. */
  homeDir?: string;
}

export interface MemorySearchOptions {
  /** Max records to return. Defaults to 10. */
  limit?: number;
  /** Only return memories for this project. */
  project?: string;
  /** Boost records carrying any of these tags. */
  tags?: string[];
}

export interface MemoryListOptions {
  /** Max records to return. Defaults to 50. */
  limit?: number;
}

const MEMORIES_FILE = 'memories.jsonl';
const LABEL_MAX = 60;

/**
 * Project id for a workspace root: first 16 hex chars of its sha1.
 * Mirrors `projectIdFor` in `@sunday/context` (style-infer.ts) — kept
 * local so this package stays dependency-light; the algorithms must stay
 * in sync.
 */
export function projectId(workspaceRoot: string): string {
  return createHash('sha1').update(resolve(workspaceRoot)).digest('hex').slice(0, 16);
}

/** Project tag for memories not tied to any workspace. */
export const GLOBAL_PROJECT = 'global';

/** Tokenise for keyword matching: lowercase alphanumerics, drop stop words. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'by',
  'is', 'are', 'was', 'were', 'be', 'it', 'this', 'that', 'we', 'i', 'you',
  'at', 'as', 'from', 'will', 'should', 'can', 'has', 'have', 'had', 'do',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * JSONL-backed store of structured long-term memories.
 *
 * The whole file is read on every operation — this is a second brain for an
 * interactive agent (hundreds of records, not millions), so simplicity beats
 * indexing. Reads tolerate missing or corrupt lines.
 */
export class MemoryStore {
  private readonly homeDir: string;
  private readonly file: string;
  /** One-time migration of untagged (pre-project) records → 'global'. */
  private migrated = false;

  constructor(opts: MemoryStoreOptions = {}) {
    this.homeDir = resolve(opts.homeDir ?? homedir());
    this.file = join(this.homeDir, '.sunday', 'memory', MEMORIES_FILE);
  }

  /**
   * Backfill: records written before project tagging (missing/empty
   * `project`) get `project = 'global'`. Runs once per store instance,
   * ahead of the first read or write.
   */
  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return;
    this.migrated = true;
    const records = await this.readAll();
    let changed = false;
    for (const rec of records) {
      if (!rec.project) {
        rec.project = GLOBAL_PROJECT;
        changed = true;
      }
    }
    if (changed) await this.writeAll(records);
  }

  private async readAll(): Promise<LongTermMemory[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: LongTermMemory[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const rec = JSON.parse(trimmed) as LongTermMemory;
        if (typeof rec.id === 'string' && typeof rec.text === 'string') out.push(rec);
      } catch {
        // Corrupt line: skip rather than losing the whole store.
      }
    }
    return out;
  }

  private async writeAll(records: LongTermMemory[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
    await writeFile(this.file, body, 'utf8');
  }

  /**
   * Persist a memory. Throws `SecretRefusedError` (and writes nothing) when
   * `text` matches a known secret pattern. Assigns a random id and the save
   * timestamp.
   */
  async save(mem: Omit<LongTermMemory, 'id' | 'timestamp'>): Promise<LongTermMemory> {
    await this.ensureMigrated();
    const clean = mem.text.trim();
    if (clean.length === 0) throw new Error('Refusing to save empty memory.');
    assertNoSecrets(clean);
    const record: LongTermMemory = {
      id: randomUUID(),
      text: clean,
      timestamp: new Date().toISOString(),
      project: mem.project,
      tags: [...mem.tags],
      source: mem.source,
    };
    const records = await this.readAll();
    records.push(record);
    await this.writeAll(records);
    return record;
  }

  /**
   * Search by relevance: each query token matching a token in `text` scores
   * +2, each requested tag present on the record scores +5, each query token
   * matching a tag scores +3. Records with a zero score are dropped; ties
   * break newest-first. An empty query returns the newest records.
   */
  async search(query: string, opts: MemorySearchOptions = {}): Promise<LongTermMemory[]> {
    await this.ensureMigrated();
    const limit = opts.limit ?? 10;
    const queryTokens = tokens(query);
    const wantedTags = (opts.tags ?? []).map((t) => t.toLowerCase());
    const scored: Array<{ mem: LongTermMemory; score: number }> = [];

    for (const mem of await this.readAll()) {
      if (opts.project !== undefined && mem.project !== opts.project) continue;
      const memTokens = new Set(tokens(mem.text));
      const memTags = mem.tags.map((t) => t.toLowerCase());
      let score = 0;
      for (const t of queryTokens) {
        if (memTokens.has(t)) score += 2;
        if (memTags.includes(t)) score += 3;
      }
      for (const t of wantedTags) {
        if (memTags.includes(t)) score += 5;
      }
      if (score > 0 || queryTokens.length === 0) scored.push({ mem, score });
    }

    scored.sort(
      (a, b) => b.score - a.score || (b.mem.timestamp < a.mem.timestamp ? -1 : 1),
    );
    return scored.slice(0, limit).map((s) => s.mem);
  }

  /** Newest-first listing. */
  async list(opts: MemoryListOptions = {}): Promise<LongTermMemory[]> {
    await this.ensureMigrated();
    const limit = opts.limit ?? 50;
    const records = await this.readAll();
    records.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return records.slice(0, limit);
  }

  /** Delete by id. Returns true when a record was removed. */
  async delete(id: string): Promise<boolean> {
    await this.ensureMigrated();
    const records = await this.readAll();
    const kept = records.filter((r) => r.id !== id);
    if (kept.length === records.length) return false;
    await this.writeAll(kept);
    return true;
  }

  /**
   * Distinct project ids present in the store, sorted. Powers the
   * "apply memories from another project" picker.
   */
  async listProjects(): Promise<string[]> {
    await this.ensureMigrated();
    const projects = new Set<string>();
    for (const mem of await this.readAll()) {
      projects.add(mem.project || GLOBAL_PROJECT);
    }
    return [...projects].sort();
  }

  /**
   * Relevance search scoped to a single project — memories from other
   * projects never leak in. Same scoring as {@link search}.
   */
  async queryByProject(
    projectId: string,
    query: string,
    limit = 10,
  ): Promise<LongTermMemory[]> {
    return this.search(query, { project: projectId, limit });
  }
}

interface ExtractionRule {
  re: RegExp;
  tags: string[];
}

/**
 * Heuristic rules for auto-extracting memories from a conversation
 * transcript. Ordered decision → preference → bugfix; the first matching
 * rule tags the sentence.
 */
const EXTRACTION_RULES: ExtractionRule[] = [
  {
    re: /\b(decided to|we will use|we['’]ve chosen|chosen as|going with)\b/i,
    tags: ['decision'],
  },
  {
    re: /\b(i prefer|i like|always|never|don['’]t use|please (always|use))\b/i,
    tags: ['preference'],
  },
  {
    re: /\b(fixed|fixed the|bug|issue|error|crash)\b.*\b(by|with|using|via)\b/i,
    tags: ['bugfix'],
  },
];

/** A single transcript turn (agent role + content), shape-agnostic. */
export interface TranscriptTurn {
  role: string;
  content: string;
}

/**
 * Heuristic (regex-only, no LLM) extraction of memory candidates from a
 * transcript. Detects:
 * - decisions: "decided to …", "we will use …", "we've chosen …"
 * - preferences: "I prefer …", "always …", "never …"
 * - bug fixes: "fixed … by …"
 *
 * Returns candidates with tags like `['decision']` and source `'auto'`.
 * Secrets are refused here too — the store re-checks, but extraction should
 * never emit a candidate containing one.
 */
export function extractMemories(
  transcript: TranscriptTurn[],
  project: string = GLOBAL_PROJECT,
): Omit<LongTermMemory, 'id' | 'timestamp'>[] {
  const candidates: Omit<LongTermMemory, 'id' | 'timestamp'>[] = [];
  const seen = new Set<string>();

  for (const turn of transcript) {
    const sentences = turn.content.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const clean = sentence.trim().replace(/\s+/g, ' ');
      if (clean.length < 12 || clean.length > 500) continue;
      const rule = EXTRACTION_RULES.find((r) => r.re.test(clean));
      if (!rule) continue;
      const key = `${rule.tags[0]}:${clean.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        assertNoSecrets(clean);
      } catch (err) {
        if (err instanceof SecretRefusedError) continue;
        throw err;
      }
      candidates.push({
        text: clean,
        project,
        tags: [...rule.tags],
        source: 'auto',
      });
    }
  }
  return candidates;
}

/**
 * Format memories as a compact bullet list for system-prompt injection.
 * Labels are truncated to keep the prompt budget bounded; the full text
 * lives in the store.
 */
export function formatMemoriesForPrompt(mems: LongTermMemory[]): string {
  if (mems.length === 0) return '';
  const lines = mems.map((m) => {
    const label = m.text.length > LABEL_MAX ? `${m.text.slice(0, LABEL_MAX)}…` : m.text;
    const date = m.timestamp.slice(0, 10);
    return `- [${date}][${m.project}][${m.tags.join(',') || 'note'}] ${label}`;
  });
  return `Relevant memories from past sessions:\n${lines.join('\n')}`;
}
