import { OrchestrationError } from './errors.js';
import type { OrchestratorHost } from './host.js';
import { checkUnitsOverlap } from './overlap.js';
import { PLANNER_SYSTEM, plannerUserPrompt } from './prompts.js';
import {
  MAX_PLAN_UNITS,
  planDraftSchema,
  planParamsSchema,
  planResultSchema,
  type OrchestrationPlan,
  type PlannedUnit,
} from './schemas.js';
import { ORCHESTRATOR_TOOL_NAMES, scopedToolDefinitions } from './toolscope.js';

/**
 * `orchestrate/plan` (§9.9.3): decompose a goal into contracted units via a
 * single model call with role=planner (the strongest reasoning route — a bad
 * decomposition wastes every request spent underneath it, §9.9.10).
 *
 * The planner is a pure reasoning step: it receives ONLY the read-only tool
 * definitions (it is instructed to call no tools), its JSON is validated, the
 * static `owns_paths` overlap check runs (§9.9.6), and the ADR-18
 * request-budget estimate is computed here — never trusted from the model —
 * and surfaced in the result BEFORE any delegation happens.
 */

export interface PlanGoalOptions {
  goal: string;
  workspaceRoot: string;
  model?: string;
  signal?: AbortSignal;
}

/** ADR-18: sum(unit budgets) + one verification pass per unit + the planner call. */
export function estimateTotalBudget(units: PlannedUnit[]): number {
  return units.reduce((sum, u) => sum + u.budget, 0) + units.length + 1;
}

/** Extract the first {...} JSON object from model text. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new OrchestrationError(
      'plan-invalid',
      'planner did not return a JSON object (no {...} block found in model output)',
    );
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch (e) {
    throw new OrchestrationError(
      'plan-invalid',
      `planner returned malformed JSON: ${(e as Error).message}`,
    );
  }
}

/** Validate a plan draft: shape, unit-count cap, unique ids, overlap check. */
export function validatePlanUnits(draft: unknown): PlannedUnit[] {
  const parsed = planDraftSchema.safeParse(draft);
  if (!parsed.success) {
    throw new OrchestrationError(
      'plan-invalid',
      `planner output failed validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  if (parsed.data.units.length > MAX_PLAN_UNITS) {
    throw new OrchestrationError(
      'too-many-units',
      `planner emitted ${parsed.data.units.length} units; the cap is ${MAX_PLAN_UNITS} (§9.9.3)`,
    );
  }
  const ids = parsed.data.units.map((u) => u.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) {
    throw new OrchestrationError('plan-invalid', `duplicate unit id: ${dup}`);
  }
  checkUnitsOverlap(parsed.data.units);
  return parsed.data.units;
}

export async function planGoal(
  host: OrchestratorHost,
  opts: PlanGoalOptions,
): Promise<OrchestrationPlan> {
  const parsed = planParamsSchema.safeParse({
    goal: opts.goal,
    workspaceRoot: opts.workspaceRoot,
    model: opts.model,
  });
  if (!parsed.success) {
    throw new OrchestrationError(
      'invalid-params',
      `orchestrate/plan: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const modelRef = parsed.data.model ?? host.defaultModel;

  const routed = await host.router.chat({
    model: modelRef,
    messages: [
      { role: 'system', content: PLANNER_SYSTEM },
      {
        role: 'user',
        content: [{ type: 'text', text: plannerUserPrompt(parsed.data.goal, parsed.data.workspaceRoot) }],
      },
    ],
    // The Orchestrator never edits files: read-only tool definitions only,
    // by construction (the planner is additionally instructed to call none).
    tools: scopedToolDefinitions(host.tools, ORCHESTRATOR_TOOL_NAMES),
    signal: opts.signal,
  });

  let text = '';
  for await (const chunk of routed.stream) {
    if (chunk.type === 'text-delta') text += chunk.delta;
    if (opts.signal?.aborted) {
      throw new OrchestrationError('plan-invalid', 'planning cancelled');
    }
  }

  const units = validatePlanUnits(extractJsonObject(text));
  return planResultSchema.parse({ units, totalBudget: estimateTotalBudget(units) });
}
