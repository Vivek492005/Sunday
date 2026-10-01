import { OrchestrationError } from './errors.js';
import type { PlannedUnit } from './schemas.js';

/**
 * Static `owns_paths` overlap check (§9.9.6). Runs at plan time, before any
 * worktree is created: two Feature Agents must never be handed intersecting
 * file ownership, because two agents editing the same files is the most
 * common source of wasted re-delegation.
 *
 * The check is deliberately CONSERVATIVE: it answers "could these two globs
 * match a common path?" and errs toward reporting overlap. A false positive
 * rejects a plan the Orchestrator must re-split; a false negative lets two
 * agents collide in one worktree. The former is strictly cheaper.
 */

function normalizeGlob(glob: string): string {
  let g = glob.trim().replace(/\\/g, '/');
  g = g.replace(/^\.\//, '');
  g = g.replace(/\/+/g, '/');
  return g;
}

/** Everything before the first wildcard char — the fixed path stem. A glob
 *  with no wildcards has itself as its stem. */
function staticStem(glob: string): string {
  const i = glob.search(/[*?[{]/);
  return i === -1 ? glob : glob.slice(0, i);
}

/**
 * True when the two globs could match a common path. Implemented on stems:
 * if one stem is a path-prefix of (or equal to) the other, their match sets
 * intersect. A glob whose stem is empty (e.g. `**\/*.ts`) overlaps everything.
 */
export function globsOverlap(a: string, b: string): boolean {
  const ga = normalizeGlob(a);
  const gb = normalizeGlob(b);
  if (!ga || !gb) return false;
  const sa = staticStem(ga);
  const sb = staticStem(gb);
  if (sa === '' || sb === '') return true;
  // Exact-file vs exact-file: overlap only when identical.
  const aIsFile = sa === ga;
  const bIsFile = sb === gb;
  if (aIsFile && bIsFile) return sa === sb;
  // Directory-ish stems: path-prefix comparison with segment awareness so
  // that `src/ab/**` does NOT overlap `src/a/**`.
  const da = sa.endsWith('/') ? sa : `${sa}/`;
  const db = sb.endsWith('/') ? sb : `${sb}/`;
  return da === db || da.startsWith(db) || db.startsWith(da);
}

export interface OverlapPair {
  unitA: string;
  unitB: string;
  globA: string;
  globB: string;
}

/** All overlapping unit pairs (by unit id). Empty = the plan is clean. */
export function findOverlaps(units: PlannedUnit[]): OverlapPair[] {
  const pairs: OverlapPair[] = [];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const ua = units[i];
      const ub = units[j];
      for (const ga of ua.owns_paths) {
        for (const gb of ub.owns_paths) {
          if (globsOverlap(ga, gb)) {
            pairs.push({ unitA: ua.id, unitB: ub.id, globA: ga, globB: gb });
          }
        }
      }
    }
  }
  return pairs;
}

/**
 * Throw an OrchestrationError('plan-overlap') when any two units' `owns_paths`
 * intersect. The Orchestrator must re-split (or extract the shared piece as
 * its own unit, sequenced first) — never create the worktrees.
 */
export function checkUnitsOverlap(units: PlannedUnit[]): void {
  const pairs = findOverlaps(units);
  if (pairs.length === 0) return;
  const detail = pairs
    .map((p) => `${p.unitA} ${JSON.stringify(p.globA)} ∩ ${p.unitB} ${JSON.stringify(p.globB)}`)
    .join('; ');
  throw new OrchestrationError(
    'plan-overlap',
    `owns_paths overlap between units: ${detail}. Re-split the plan so no two units own intersecting paths (§9.9.6).`,
  );
}
