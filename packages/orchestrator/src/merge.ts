/**
 * @sunday/orchestrator — Parallel Agents: merge-phase textual conflict detection.
 *
 * After all units settle, each successful unit's worktree holds a branch off
 * the same base. Before merging anything, we parse every unit's unified diff
 * and look for TEXTUAL overlap: two units touching the same file with
 * overlapping old-line ranges and DIFFERENT new-side content. Identical hunks
 * (same range, same new content — e.g. after conflict resolution copies one
 * unit's file into another's worktree) are NOT conflicts: git merges those
 * cleanly as duplicate changes.
 *
 * A detected overlap becomes a structured MergeConflict and the run stops in
 * 'conflicted' — never auto-resolved, never partially merged. Human (or
 * Worker 2's RPC) resolves via resolveRunConflicts.
 */

import type { ConflictHunk, MergeConflict } from './schemas.js';

/** One `@@ -a,b +c,d @@` hunk with its body lines. */
export interface DiffHunk {
  /** Repo-relative path (from the `+++ b/...` line). */
  file: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Hunk body lines (the ` `/`+`/`-` lines after the @@ header). */
  body: string;
  /** True when the file is newly created by this diff section. */
  isNewFile: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function fileFromSection(section: string): { file: string; isNewFile: boolean } | undefined {
  let minus: string | undefined;
  let plus: string | undefined;
  for (const line of section.split('\n')) {
    if (line.startsWith('--- ')) minus = line.slice(4).trim();
    else if (line.startsWith('+++ ')) plus = line.slice(4).trim();
    if (minus && plus) break;
  }
  // `+++ /dev/null` = deletion; `--- /dev/null` = creation.
  if (plus && plus !== '/dev/null') {
    return { file: plus.replace(/^b\//, ''), isNewFile: minus === '/dev/null' };
  }
  if (minus && minus !== '/dev/null') {
    return { file: minus.replace(/^a\//, ''), isNewFile: false };
  }
  return undefined;
}

/** Parse the hunks of a unified diff (as produced by `git diff`). */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const sections = diff.split(/^diff --git /m).slice(1);
  for (const section of sections) {
    const f = fileFromSection(section);
    if (!f) continue;
    const lines = section.split('\n');
    let i = 0;
    while (i < lines.length) {
      const m = HUNK_HEADER.exec(lines[i]);
      if (!m) {
        i += 1;
        continue;
      }
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
        body.push(lines[i]);
        i += 1;
      }
      hunks.push({
        file: f.file,
        oldStart,
        oldCount,
        newStart,
        newCount,
        body: body.join('\n'),
        isNewFile: f.isNewFile,
      });
    }
  }
  return hunks;
}

/** Old-side range as [start, end). */
function oldRange(h: DiffHunk): [number, number] {
  return [h.oldStart, h.oldStart + h.oldCount];
}

/**
 * True when two hunks' old-side ranges overlap. Pure insertions (count 0)
 * count as overlapping when the insertion point sits inside the other's
 * range; two creations of the same new file always overlap.
 */
function rangesOverlap(a: DiffHunk, b: DiffHunk): boolean {
  const [as, ae] = oldRange(a);
  const [bs, be] = oldRange(b);
  if (as < be && bs < ae) return true;
  if (a.oldCount === 0 && bs <= as && as < be) return true;
  if (b.oldCount === 0 && as <= bs && bs < ae) return true;
  if (a.isNewFile && b.isNewFile && a.oldStart === 0 && b.oldStart === 0) return true;
  return false;
}

export interface UnitDiff {
  unitId: string;
  diff: string;
}

/**
 * Pairwise conflict scan over all units' diffs. Returns one MergeConflict per
 * file (index = position in the returned array), each carrying the
 * conflicting hunk pairs. Identical hunks (same new-side body) are skipped —
 * they merge cleanly.
 */
export function findMergeConflicts(unitDiffs: UnitDiff[]): MergeConflict[] {
  const parsed = unitDiffs.map((u) => ({ unitId: u.unitId, hunks: parseDiffHunks(u.diff) }));
  const byFile = new Map<string, ConflictHunk[]>();
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i];
      const b = parsed[j];
      for (const ha of a.hunks) {
        for (const hb of b.hunks) {
          if (ha.file !== hb.file) continue;
          if (!rangesOverlap(ha, hb)) continue;
          if (ha.body === hb.body) continue; // identical change — merges cleanly
          const [as, ae] = oldRange(ha);
          const [bs, be] = oldRange(hb);
          const hunk: ConflictHunk = {
            file: ha.file,
            unitA: a.unitId,
            unitB: b.unitId,
            rangeA: [as, ae],
            rangeB: [bs, be],
          };
          const list = byFile.get(ha.file);
          if (list) list.push(hunk);
          else byFile.set(ha.file, [hunk]);
        }
      }
    }
  }
  return [...byFile.entries()].map(([file, hunks], index) => ({ index, file, hunks }));
}
