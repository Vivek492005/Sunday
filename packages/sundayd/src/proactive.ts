// sundayd — Proactive Engine (F4: Proactive Mode).
//
// Records background-agent actions taken without being asked (lint,
// typecheck, test-investigation, suggestions) to `~/.sunday/proactive.log`
// as JSONL. The log is append-only for normal operation; `markUndone` rewrites
// it only to flip an entry's `undone` flag when the user reverts the action.
//
// POLICY — observe + report, never silent mutation:
// The engine itself only *records* actions. It never edits workspace files or
// runs commands on its own; callers decide what to act on. All filesystem
// writes are mkdir-p'd so a missing ~/.sunday is not an error.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ProactiveConfig {
  /** Master switch for proactive behavior. */
  enabled: boolean;
  /** Idle minutes before an idle-triggered action (e.g. test investigation). */
  idleMinutes: number;
  /** Override the default `<home>/.sunday/proactive.log`. */
  logPath?: string;
}

export type ProactiveActionKind = 'lint' | 'typecheck' | 'test-investigate' | 'suggestion';

export interface ProactiveAction {
  id: string;
  /** ISO-8601 timestamp of when the action was recorded. */
  at: string;
  kind: ProactiveActionKind;
  /** File path, test name, or other target the action concerned. */
  target: string;
  summary: string;
  /** Set when the user undid/reverted the action. */
  undone?: boolean;
}

export interface ProactiveEngineOptions {
  homeDir?: string;
  /** Override the clock (for tests). */
  clock?: () => number;
  /** Idle threshold in minutes for `shouldInvestigate` (default 5). */
  idleMinutes?: number;
}

const DEFAULT_IDLE_MINUTES = 5;

export class ProactiveEngine {
  private readonly logPath: string;
  private readonly idleMinutes: number;
  private readonly clock: () => number;

  constructor(opts: ProactiveEngineOptions = {}) {
    const home = opts.homeDir ?? os.homedir();
    this.logPath = path.join(home, '.sunday', 'proactive.log');
    this.idleMinutes = opts.idleMinutes !== undefined && Number.isFinite(opts.idleMinutes)
      ? opts.idleMinutes
      : DEFAULT_IDLE_MINUTES;
    this.clock = opts.clock ?? (() => Date.now());
  }

  /** Path of the JSONL log file. */
  getLogPath(): string {
    return this.logPath;
  }

  /** Append one action to the JSONL log (mkdir -p the parent dir first). */
  async logAction(a: Omit<ProactiveAction, 'id' | 'at'>): Promise<ProactiveAction> {
    const action: ProactiveAction = {
      ...a,
      id: randomUUID(),
      at: new Date(this.clock()).toISOString(),
    };
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    await fs.appendFile(this.logPath, JSON.stringify(action) + '\n', 'utf8');
    return action;
  }

  /** Read the log back, newest first. `limit` caps the number returned. */
  async history(limit?: number): Promise<ProactiveAction[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.logPath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const actions: ProactiveAction[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        actions.push(JSON.parse(trimmed) as ProactiveAction);
      } catch {
        // Skip corrupt lines rather than failing the whole history read.
      }
    }
    actions.reverse();
    return typeof limit === 'number' && limit >= 0 ? actions.slice(0, limit) : actions;
  }

  /**
   * Mark an action as undone. Reads all entries, flips the matching one, and
   * rewrites the file. Returns false when no entry with that id exists.
   */
  async markUndone(id: string): Promise<boolean> {
    const existing = await this.history();
    if (!existing.some((a) => a.id === id)) return false;
    const oldestFirst = [...existing].reverse();
    for (const a of oldestFirst) {
      if (a.id === id) a.undone = true;
    }
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    await fs.writeFile(
      this.logPath,
      oldestFirst.map((a) => JSON.stringify(a)).join('\n') + '\n',
      'utf8',
    );
    return true;
  }

  /**
   * Pure decision rule: investigate failing tests when the user has been idle
   * for at least `idleMinutes` AND tests are currently failing. Returns false
   * whenever tests pass, regardless of idleness.
   */
  shouldInvestigate(lastUserActivityAt: number, testsFailing: boolean, now: number = this.clock()): boolean {
    if (!testsFailing) return false;
    const idleMs = now - lastUserActivityAt;
    return idleMs >= this.idleMinutes * 60 * 1000;
  }
}

/**
 * Pure mapping from a saved file path to the proactive check it warrants:
 * `.ts`/`.tsx` → 'typecheck', `.js`/`.jsx`/`.mjs` → 'lint', anything else → null.
 */
export function lintTargetFor(filePath: string): 'lint' | 'typecheck' | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'typecheck';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs') return 'lint';
  return null;
}
