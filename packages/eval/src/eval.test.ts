// @sunday/eval — harness tests.
//
// The fake adapter replays scripted tool calls through the REAL tool
// registry, so this suite is a genuine benchmark run: every task must pass
// end-to-end with no API keys. The orchestration and browser-policy tasks
// additionally assert against the real planner and policy modules.

import { describe, expect, it } from 'vitest';
import { validatePlanUnits } from '@sunday/orchestrator';
import { BrowserPolicy, BrowserPolicyError } from '@sunday/browserd';
import { FakeModelAdapter } from './adapters.js';
import { runBenchmark } from './runner.js';
import { TASKS } from './tasks.js';

describe('eval harness (fake-scripted adapter)', () => {
  it('all 10 benchmark tasks pass with 100% tool reliability', async () => {
    const report = await runBenchmark(new FakeModelAdapter(), {
      outDir: '/tmp/sunday-eval-test',
    });
    expect(report.total).toBe(10);
    expect(report.passed).toBe(10);
    expect(report.meanToolReliability).toBe(1);
    for (const t of report.tasks) {
      expect(t.pass, `${t.taskId}: ${t.notes}`).toBe(true);
    }
  }, 120_000);

  it('runs a subset of tasks on request', async () => {
    const report = await runBenchmark(new FakeModelAdapter(), {
      tasks: ['read-file', 'write-file'],
      outDir: '/tmp/sunday-eval-test-subset',
    });
    expect(report.total).toBe(2);
    expect(report.passed).toBe(2);
  }, 60_000);

  it('every task has a non-empty prompt, script and checker', () => {
    for (const t of TASKS) {
      expect(t.prompt.length).toBeGreaterThan(0);
      expect(t.script.length).toBeGreaterThan(0);
    }
  });
});

describe('eval task: orchestrate-plan (real planner)', () => {
  const goodPlan = {
    units: [
      {
        id: 'api',
        title: 'Build the API layer',
        owns_paths: ['src/api/**'],
        acceptance: ['all api tests pass'],
        budget: 20,
      },
      {
        id: 'web',
        title: 'Build the web UI',
        owns_paths: ['src/web/**'],
        acceptance: ['all web tests pass'],
        budget: 20,
      },
    ],
  };

  it('accepts a valid 2-unit plan with disjoint ownership', () => {
    const units = validatePlanUnits(goodPlan);
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.id)).toEqual(['api', 'web']);
  });

  it('rejects overlapping owns_paths', () => {
    const bad = {
      units: [
        { ...goodPlan.units[0] },
        { ...goodPlan.units[1], owns_paths: ['src/api/**', 'src/web/**'] },
      ],
    };
    expect(() => validatePlanUnits(bad)).toThrow();
  });

  it('rejects duplicate unit ids', () => {
    const bad = { units: [{ ...goodPlan.units[0] }, { ...goodPlan.units[0] }] };
    expect(() => validatePlanUnits(bad)).toThrow(/duplicate unit id/);
  });
});

describe('eval task: browser-policy (real policy module)', () => {
  const policy = new BrowserPolicy();
  const approved = new Set<string>();

  it('blocks file:// URLs', () => {
    expect(() => policy.checkNavigation('file:///etc/passwd', approved)).toThrow(BrowserPolicyError);
  });

  it('allows localhost without approval', () => {
    expect(policy.checkNavigation('http://localhost:3000/', approved)).toEqual({ kind: 'allow' });
  });

  it('asks approval for a new public origin', () => {
    const d = policy.checkNavigation('https://example.com/', approved);
    expect(d.kind).toBe('needsApproval');
  });
});
