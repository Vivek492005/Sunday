/** @sunday/orchestrator — unit tests for the pure plan/overlap logic.
 *  The daemon-level integration tests (real AgentLoop) live in
 *  @sunday/sundayd's orchestration-integration.test.ts, because this package
 *  must not depend on @sunday/sundayd (that would be a package cycle and
 *  break pnpm's topological build order). */
import { describe, expect, it } from 'vitest';
import {
  validatePlanUnits,
  estimateTotalBudget,
  extractJsonObject,
} from './planner.js';
import { globsOverlap, findOverlaps, checkUnitsOverlap } from './overlap.js';
import { OrchestrationError } from './errors.js';
import type { PlannedUnit } from './schemas.js';

function unit(partial: Partial<PlannedUnit> = {}): PlannedUnit {
  return {
    id: 'u1',
    title: 'unit one',
    prompt: 'do the thing',
    owns_paths: ['src/a/**'],
    budget: 5,
    acceptance: ['it works'],
    ...partial,
  } as PlannedUnit;
}

describe('validatePlanUnits', () => {
  it('accepts a well-formed plan', () => {
    const units = validatePlanUnits({
      units: [unit({ id: 'u1' }), unit({ id: 'u2', owns_paths: ['src/b/**'] })],
    });
    expect(units).toHaveLength(2);
  });

  it('rejects non-object drafts', () => {
    expect(() => validatePlanUnits('nope')).toThrow(OrchestrationError);
    expect(() => validatePlanUnits(null)).toThrow(OrchestrationError);
  });

  it('rejects duplicate unit ids', () => {
    expect(() =>
      validatePlanUnits({ units: [unit({ id: 'u1' }), unit({ id: 'u1' })] }),
    ).toThrow(/duplicate unit id/);
  });

  it('rejects more than 8 units', () => {
    const units = Array.from({ length: 9 }, (_, i) =>
      unit({ id: `u${i}`, owns_paths: [`src/${i}/**`] }),
    );
    expect(() => validatePlanUnits({ units })).toThrow(/cap is 8/);
  });

  it('rejects overlapping owns_paths', () => {
    expect(() =>
      validatePlanUnits({
        units: [unit({ id: 'u1', owns_paths: ['src/**'] }), unit({ id: 'u2', owns_paths: ['src/a/**'] })],
      }),
    ).toThrow(OrchestrationError);
  });
});

describe('estimateTotalBudget', () => {
  it('sums unit budgets + one verification per unit + the planner call', () => {
    expect(estimateTotalBudget([unit({ budget: 5 }), unit({ budget: 3 })])).toBe(5 + 3 + 2 + 1);
    expect(estimateTotalBudget([])).toBe(1);
  });
});

describe('extractJsonObject', () => {
  it('extracts the first {...} block', () => {
    expect(extractJsonObject('prefix {"a":1} suffix')).toEqual({ a: 1 });
  });
  it('throws when there is no object', () => {
    expect(() => extractJsonObject('no braces here')).toThrow(/no \{\.\.\.\} block/);
  });
  it('throws on malformed JSON', () => {
    expect(() => extractJsonObject('{oops}')).toThrow(/malformed JSON/);
  });
});

describe('overlap utils', () => {
  it('globsOverlap detects containment', () => {
    expect(globsOverlap('src/**', 'src/a/b.ts')).toBe(true);
    expect(globsOverlap('src/a/**', 'src/b/**')).toBe(false);
  });

  it('findOverlaps reports conflicting pairs', () => {
    const pairs = findOverlaps([
      unit({ id: 'u1', owns_paths: ['src/**'] }),
      unit({ id: 'u2', owns_paths: ['src/a/**'] }),
      unit({ id: 'u3', owns_paths: ['docs/**'] }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ unitA: 'u1', unitB: 'u2' });
  });

  it('checkUnitsOverlap throws on conflict, passes when clean', () => {
    expect(() =>
      checkUnitsOverlap([
        unit({ id: 'u1', owns_paths: ['src/**'] }),
        unit({ id: 'u2', owns_paths: ['src/a/**'] }),
      ]),
    ).toThrow(OrchestrationError);
    expect(() =>
      checkUnitsOverlap([
        unit({ id: 'u1', owns_paths: ['src/a/**'] }),
        unit({ id: 'u2', owns_paths: ['src/b/**'] }),
      ]),
    ).not.toThrow();
  });
});
