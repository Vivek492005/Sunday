// @sunday/eval — F12 versioned task-pack validation.
//
// The task pack is the benchmark's contract: versioned, fixed seeds,
// categorized, hidden checkers. This module validates those invariants so a
// malformed pack fails fast instead of silently poisoning the scoreboard.

import {
  REQUIRED_TASK_CATEGORIES,
  TASK_PACK_VERSION,
  type EvalTask,
  type TaskCategory,
} from './types.js';

export interface TaskPackInfo {
  version: number;
  total: number;
  categories: TaskCategory[];
  counts: Record<string, number>;
}

/** Throw unless the task pack satisfies every F12 structural invariant. */
export function validateTaskPack(tasks: EvalTask[]): TaskPackInfo {
  if (tasks.length === 0) throw new Error('task pack is empty');
  if (!Number.isInteger(TASK_PACK_VERSION) || TASK_PACK_VERSION < 1) {
    throw new Error(`invalid TASK_PACK_VERSION: ${TASK_PACK_VERSION}`);
  }

  const seenIds = new Set<string>();
  for (const t of tasks) {
    if (!t.id || typeof t.id !== 'string') throw new Error('task with missing id');
    if (seenIds.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
    seenIds.add(t.id);
    if (!t.title) throw new Error(`task ${t.id}: missing title`);
    if (!t.prompt || t.prompt.length === 0) throw new Error(`task ${t.id}: empty prompt`);
    if (!Array.isArray(t.script) || t.script.length === 0) {
      throw new Error(`task ${t.id}: empty script`);
    }
    if (typeof t.check !== 'function') throw new Error(`task ${t.id}: missing checker`);
    if (!t.category || typeof t.category !== 'string') {
      throw new Error(`task ${t.id}: missing category (F12 requires one)`);
    }
    if (!Number.isInteger(t.seed)) {
      throw new Error(`task ${t.id}: seed must be an integer (fixed-seed determinism)`);
    }
    if (typeof t.setup !== 'function') throw new Error(`task ${t.id}: missing setup`);
  }

  const counts = categoryCounts(tasks);
  const missing = REQUIRED_TASK_CATEGORIES.filter((c) => (counts[c] ?? 0) === 0);
  if (missing.length > 0) {
    throw new Error(`task pack missing required categories: ${missing.join(', ')}`);
  }

  return {
    version: TASK_PACK_VERSION,
    total: tasks.length,
    categories: Object.keys(counts).sort() as TaskCategory[],
    counts,
  };
}

/** Per-category task counts. */
export function categoryCounts(tasks: EvalTask[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.category] = (counts[t.category] ?? 0) + 1;
  return counts;
}
