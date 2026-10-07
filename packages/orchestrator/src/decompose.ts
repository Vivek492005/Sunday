// @sunday/orchestrator — decompose.ts: one-prompt swarm decomposition (F3).
//
// Mission-control entry point for the One-Prompt Swarm UI: decompose a
// single user goal into contracted work units via the existing planner
// (§9.9.3, planGoal), with extra swarm-level validation, plus a
// human-readable plan summary for the Kanban board header.

import { OrchestrationError } from './errors.js';
import type { OrchestratorHost } from './host.js';
import { planGoal } from './planner.js';
import { MAX_PLAN_UNITS, type OrchestrationPlan } from './schemas.js';

export interface DecomposeOptions {
  goal: string;
  workspaceRoot: string;
  model?: string;
  signal?: AbortSignal;
  host: OrchestratorHost;
}

/** Swarm-level plan validation: at least 1 unit, at most MAX_PLAN_UNITS, each unit needs a non-empty goal. */
function validateDecomposedPlan(plan: OrchestrationPlan): void {
  if (!plan || !Array.isArray(plan.units) || plan.units.length < 1) {
    throw new OrchestrationError(
      'plan-invalid',
      'decomposed plan must contain at least 1 unit',
    );
  }
  if (plan.units.length > MAX_PLAN_UNITS) {
    throw new OrchestrationError(
      'too-many-units',
      `decomposed plan has ${plan.units.length} units; the cap is ${MAX_PLAN_UNITS} (§9.9.3)`,
    );
  }
  for (const unit of plan.units) {
    const goal = (unit.title ?? '').trim();
    if (!goal) {
      throw new OrchestrationError(
        'plan-invalid',
        `decomposed unit '${unit.id}' has an empty goal`,
      );
    }
  }
}

/**
 * Decompose a goal into contracted work units. Thin wrapper around the
 * planner's `planGoal` — the LLM host is accepted via `opts.host` and passed
 * straight through, so no real model is involved unless the caller wires one.
 */
export async function decompose(opts: DecomposeOptions): Promise<OrchestrationPlan> {
  const plan = await planGoal(opts.host, {
    goal: opts.goal,
    workspaceRoot: opts.workspaceRoot,
    model: opts.model,
    signal: opts.signal,
  });
  validateDecomposedPlan(plan);
  return plan;
}

/** Human-readable multi-line plan summary: unit id, goal, budget, plus the ADR-18 total budget. */
export function summarizePlan(plan: OrchestrationPlan): string {
  const lines: string[] = [
    `Plan: ${plan.units.length} unit(s), total budget ${plan.totalBudget} request(s)`,
  ];
  for (const unit of plan.units) {
    lines.push(`- [${unit.id}] ${unit.title} (budget: ${unit.budget})`);
  }
  return lines.join('\n');
}
