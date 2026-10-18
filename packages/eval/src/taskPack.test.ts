// @sunday/eval — F12 task-pack validation tests.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASKS } from './tasks.js';
import { categoryCounts, validateTaskPack } from './taskPack.js';
import { REQUIRED_TASK_CATEGORIES, TASK_PACK_VERSION, type EvalTask } from './types.js';

describe('F12 task pack', () => {
  it('validates: versioned, 30+ tasks, all required categories', () => {
    const info = validateTaskPack(TASKS);
    expect(info.version).toBe(TASK_PACK_VERSION);
    expect(info.total).toBeGreaterThanOrEqual(30);
    for (const cat of REQUIRED_TASK_CATEGORIES) {
      expect(info.counts[cat] ?? 0, `category ${cat}`).toBeGreaterThan(0);
    }
  });

  it('every task has a unique id, category, integer seed', () => {
    const ids = TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const seeds = TASKS.map((t) => t.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
    for (const t of TASKS) {
      expect(t.category).toBeTruthy();
      expect(Number.isInteger(t.seed)).toBe(true);
    }
  });

  it('categoryCounts sums to the pack size', () => {
    const counts = categoryCounts(TASKS);
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(TASKS.length);
  });

  it('rejects duplicate ids', () => {
    const dup = [...TASKS, { ...TASKS[0] }];
    expect(() => validateTaskPack(dup)).toThrow(/duplicate task id/);
  });

  it('rejects a task with an empty script', () => {
    const bad: EvalTask[] = [
      {
        ...TASKS[0],
        id: 'bad-empty-script',
        script: [],
      },
    ];
    expect(() => validateTaskPack(bad)).toThrow(/empty script/);
  });

  it('rejects a pack missing a required category', () => {
    const filtered = TASKS.filter((t) => t.category !== 'security');
    expect(filtered.length).toBeGreaterThan(0);
    expect(() => validateTaskPack(filtered)).toThrow(/missing required categories.*security/);
  });

  it('rejects an empty pack', () => {
    expect(() => validateTaskPack([])).toThrow(/empty/);
  });
});

/** Recursive file snapshot (content hashes by path), ignoring .git. */
function snapshotDir(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out;
}

describe('F12 fixed-seed determinism', () => {
  it('every task setup produces identical fixtures on repeat runs', async () => {
    for (const task of TASKS) {
      const a = mkdtempSync(join(tmpdir(), 'pack-det-a-'));
      const b = mkdtempSync(join(tmpdir(), 'pack-det-b-'));
      try {
        await task.setup(a);
        await task.setup(b);
        const sa = snapshotDir(a);
        const sb = snapshotDir(b);
        expect([...sa.keys()].sort(), `${task.id}: file list`).toEqual([...sb.keys()].sort());
        for (const [rel, content] of sa) {
          expect(sb.get(rel), `${task.id}: ${rel}`).toBe(content);
        }
      } finally {
        rmSync(a, { recursive: true, force: true });
        rmSync(b, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
