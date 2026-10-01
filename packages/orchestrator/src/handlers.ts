import { OrchestrationError } from './errors.js';
import type { OrchestratorHost, OrchestrationMethodHandler } from './host.js';
import { planGoal } from './planner.js';
import { runOrchestration } from './runner.js';
import {
  ORCHESTRATE_METHODS,
  type OrchestrateMethodName,
} from './schemas.js';

/**
 * JSON-RPC handler table for `orchestrate/*`. Params are validated against
 * the ORCHESTRATE_METHODS zod schemas (same convention as the protocol
 * `*_METHODS` tables); results are validated before returning. The parent
 * registers these on the daemon via `registerOrchestrationMethods`
 * (see host.ts) — this package never touches cli.ts or the daemon's
 * dispatch table itself.
 */
export function createOrchestrationHandlers(
  host: OrchestratorHost,
): Record<OrchestrateMethodName, OrchestrationMethodHandler> {
  return {
    'orchestrate/plan': async (params: unknown) => {
      const def = ORCHESTRATE_METHODS['orchestrate/plan'];
      const p = def.params.safeParse(params);
      if (!p.success) {
        throw new OrchestrationError(
          'invalid-params',
          `orchestrate/plan: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      const plan = await planGoal(host, {
        goal: p.data.goal,
        workspaceRoot: p.data.workspaceRoot,
        model: p.data.model,
      });
      return def.result.parse(plan);
    },
    'orchestrate/run': async (params: unknown) => {
      const def = ORCHESTRATE_METHODS['orchestrate/run'];
      const p = def.params.safeParse(params);
      if (!p.success) {
        throw new OrchestrationError(
          'invalid-params',
          `orchestrate/run: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      // Long-running: progress streams as `orchestrate/event` notifications;
      // the RPC resolves with the final per-unit results.
      const result = await runOrchestration(host, {
        goal: p.data.goal,
        workspaceRoot: p.data.workspaceRoot,
        model: p.data.model,
        plan: p.data.plan,
      });
      return def.result.parse(result);
    },
  };
}
