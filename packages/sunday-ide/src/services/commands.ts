/**
 * Command registry + fuzzy finder backing the Sunday command palette.
 * Pure service — no React, no DOM. The palette component renders from here.
 */

export interface SundayCommand {
  id: string;
  title: string;
  hint?: string;
  run: () => void | Promise<void>;
}

/** Registry keyed by command id — re-registering an id replaces it (last wins). */
const registry = new Map<string, SundayCommand>();

export function registerCommand(cmd: SundayCommand): void {
  registry.set(cmd.id, cmd);
}

export function unregisterCommand(id: string): void {
  registry.delete(id);
}

/** Commands in registration order (re-registered ids keep their first position). */
export function getCommands(): SundayCommand[] {
  return [...registry.values()];
}

/**
 * Subsequence match positions of `query` inside `title` (case-insensitive).
 * Returns null when the query is not a subsequence; [] for an empty query.
 */
export function matchTitleIndices(title: string, query: string): number[] | null {
  const t = title.toLowerCase();
  const q = query.toLowerCase().trim();
  if (q.length === 0) return [];
  const indices: number[] = [];
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return null;
    indices.push(found);
    ti = found + 1;
  }
  return indices;
}

function scoreTitle(title: string, indices: number[]): number {
  let score = 0;
  let prev = -2;
  for (const i of indices) {
    const wordStart = i === 0 || !/[a-z0-9]/i.test(title[i - 1]);
    if (wordStart) {
      score += 10; // prefix / word-boundary match
    } else if (i === prev + 1) {
      score += 4; // consecutive run bonus
    } else {
      score += 1; // scattered match
    }
    prev = i;
  }
  // Slight preference for shorter titles; never outweighs a real match-quality gap.
  score -= title.length * 0.01;
  return score;
}

/**
 * Subsequence fuzzy filter over command titles, case-insensitive.
 * Empty query returns every command in registration order.
 * Ranked: prefix/word-boundary matches first, then consecutive runs,
 * then scattered matches. Stable for ties.
 */
export function fuzzyFilter(query: string, commands: SundayCommand[]): SundayCommand[] {
  if (query.trim().length === 0) return [...commands];
  const scored: { cmd: SundayCommand; score: number }[] = [];
  for (const cmd of commands) {
    const indices = matchTitleIndices(cmd.title, query);
    if (indices !== null) {
      scored.push({ cmd, score: scoreTitle(cmd.title, indices) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.cmd);
}
