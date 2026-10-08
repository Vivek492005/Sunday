import { OrchestrationError } from './errors.js';
import type { OrchestratorHost, OrchestrationMethodHandler } from './host.js';
import { planGoal } from './planner.js';
import {
  cancelOrchestrationRun,
  getOrchestrationRunState,
  resolveRunConflicts,
  runOrchestration,
} from './runner.js';
import {
  ORCHESTRATE_METHODS,
  orchestrationRunStateSchema,
  type OrchestrateMethodName,
} from './schemas.js';

/**
 * JSON-RPC handler table for `orchestrate/*`. Params are validated against
 * the ORCHESTRATE_METHODS zod schemas (same convention as the protocol
 * `*_METHODS` tables); results are validated before returning. The parent
 * registers these on the daemon via `registerOrchestrationMethods`
 * (see host.ts) — this package never touches cli.ts or the daemon's
 * dispatch table itself.
 *
 * Parallel-agents RPCs (shared contract): `orchestrate/stop`,
 * `orchestrate/status`, `orchestrate/merge`, `orchestrate/resolveConflict`.
 * `orchestrate/merge` is a merge-status query for an existing run (the merge
 * phase itself runs automatically at the end of a parallel run or after
 * `orchestrate/resolveConflict`).
 */
export function createOrchestrationHandlers(
  host: OrchestratorHost,
): Record<OrchestrateMethodName, OrchestrationMethodHandler> {
  function mergedOf(runId: string): string[] {
    const state = getOrchestrationRunState(runId);
    if (!state) {
      throw new OrchestrationError('unknown-run', `no such orchestration run: ${runId}`);
    }
    return state.units.filter((u) => u.sha).map((u) => u.id);
  }

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
      // the RPC resolves with the final per-unit results. The run is
      // registered in the active-runs registry at start so
      // orchestrate/stop|status work mid-flight.
      const result = await runOrchestration(host, {
        goal: p.data.goal,
        workspaceRoot: p.data.workspaceRoot,
        model: p.data.model,
        plan: p.data.plan,
        parallel: p.data.parallel,
        maxParallel: p.data.maxParallel,
        entitlementCaps: p.data.entitlementCaps,
      });
      return def.result.parse(result);
    },
    'orchestrate/stop': async (params: unknown) => {
      const def = ORCHESTRATE_METHODS['orchestrate/stop'];
      const p = def.params.safeParse(params);
      if (!p.success) {
        throw new OrchestrationError(
          'invalid-params',
          `orchestrate/stop: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      return def.result.parse(await cancelOrchestrationRun(p.data.runId));
    },
    'orchestrate/status': async (params: unknown) => {
      const def = ORCHESTRATE_METHODS['orchestrate/status'];
      const p = def.params.safeParse(params);
      if (!p.success) {
        throw new OrchestrationError(
          'invalid-params',
          `orchestrate/status: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      const state = getOrchestrationRunState(p.data.runId);
      if (!state) {
        throw new OrchestrationError('unknown-run', `no such orchestration run: ${p.data.runId}`);
      }
      return def.result.parse(orchestrationRunStateSchema.parse(state));
    },
    'orchestrate/merge': async (params: unknown) => {
      const def = ORCHESTRATE_METHODS['orchestrate/merge'];
      const p = def.params.safeParse(params);
      if (!p.success) {
        throw new OrchestrationError(
          'invalid-params',
          `orchestrate/merge: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      const state = getOrchestrationRunState(p.data.runId);
      if (!state) {
        throw new OrchestrationError('unknown-run', `no such orchestration run: ${p.data.runId}`);
      }
      return def.result.parse({ conflicts: state.conflicts, merged: mergedOf(p.data.runId) });
    },
    'orchestrate/resolveConflict': async (params: unknown) => {
      const def = ORCHESTRATE_METHODS['orchestrate/resolveConflict'];
      const p = def.params.safeParse(params);
      if (!p.success) {
        throw new OrchestrationError(
          'invalid-params',
          `orchestrate/resolveConflict: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      await resolveRunConflicts(p.data.runId, p.data.resolutions);
      const state = getOrchestrationRunState(p.data.runId);
      return def.result.parse({
        conflicts: state?.conflicts ?? [],
        merged: mergedOf(p.data.runId),
      });
    },
  };
}
