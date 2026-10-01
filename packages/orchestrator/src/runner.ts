import { randomUUID } from 'node:crypto';
import type { ChatEvent } from '@sunday/protocol';
import { OrchestrationError } from './errors.js';
import type { OrchestratorHost } from './host.js';
import { estimateTotalBudget, planGoal, validatePlanUnits } from './planner.js';
import {
  featureAgentFixPrompt,
  featureAgentPrompt,
  featureAgentSystemPrompt,
  verifierPrompt,
  verifierSystemPrompt,
} from './prompts.js';
import {
  MAX_UNIT_RETRIES,
  checkpointCreateResultSchema,
  runParamsSchema,
  runResultSchema,
  worktreeAddResultSchema,
  worktreeMergeResultSchema,
  type OrchestrationEvent,
  type OrchestrationPhase,
  type OrchestrationRunResult,
  type PlannedUnit,
  type UnitResult,
} from './schemas.js';
import { VERIFIER_TOOL_NAMES, scopedRegistry } from './toolscope.js';

/**
 * `orchestrate/run` (§9.9.5, §9.9.9) — SEQUENTIAL-ONLY v1 (ADR-17).
 *
 * For each contracted unit in order:
 *   worktree/add (branch `sunday/feat/<unit-id>`)
 *     → Feature Agent: a full sundayd agent loop, role=coder, the FULL tool
 *       catalogue, cwd confined to the worktree, max-steps from the unit's
 *       request budget
 *     → Verifier: a SEPARATE session given ONLY the diff + acceptance
 *       criteria (ADR-16), read-only tools by construction
 *     → pass: worktree/merge (+ checkpoint) → next unit
 *     → fail: FIXING — the SAME feature agent is re-delegated with the
 *       failure evidence (max 2 retries), then the unit is marked failed
 *       and the run CONTINUES with the next unit (one unit never blocks
 *       the whole run).
 *
 * Progress is streamed as `orchestrate/event` notifications; the RPC returns
 * the final per-unit results once every unit has been attempted.
 */

export interface RunOrchestrationOptions {
  goal: string;
  workspaceRoot: string;
  model?: string;
  plan?: { units: PlannedUnit[] };
  signal?: AbortSignal;
}

/** Cap the diff handed to the verifier so one giant slice can't blow the
 *  verifier's context window. */
const MAX_VERIFIER_DIFF_CHARS = 40_000;

interface UnitContext {
  runId: string;
  workspaceRoot: string;
  model: string;
  unit: PlannedUnit;
  signal?: AbortSignal;
  notify: (unitId: string, phase: OrchestrationPhase, detail?: string) => void;
}

type TurnOutcome = 'stop' | 'max-steps' | 'error' | 'cancelled';

interface TurnCapture {
  outcome: TurnOutcome;
  /** Assistant text accumulated over the turn (tail-kept). */
  text: string;
}

function captureSink(cap: TurnCapture): (sessionId: string, turnId: string, event: ChatEvent) => void {
  return (_sessionId, _turnId, event) => {
    if (event.type === 'text-delta') {
      cap.text = `${cap.text}${event.delta}`.slice(-8000);
    } else if (event.type === 'turn-end') {
      cap.outcome = event.finishReason === 'stop' ? 'stop' : event.finishReason === 'max-steps' ? 'max-steps' : 'error';
    } else if (event.type === 'turn-error') {
      cap.outcome = 'error';
      cap.text = `${cap.text}\n[turn-error: ${event.message}]`.slice(-8000);
    }
  };
}

function sanitizeBranchId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

async function dispatchChecked<T>(
  host: OrchestratorHost,
  method: string,
  params: unknown,
  label: string,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await host.dispatch(method, params);
  } catch (e) {
    throw new OrchestrationError(
      'dispatch-failed',
      `${label}: ${method} failed: ${(e as Error).message}`,
    );
  }
  return raw as T;
}

/**
 * Run one Feature Agent attempt: a full sundayd agent-loop session
 * (role=coder, FULL tool catalogue, cwd confined to the worktree, its own
 * model route, max-steps from the unit's request budget).
 */
async function runFeatureAgent(
  host: OrchestratorHost,
  ctx: UnitContext,
  worktreePath: string,
  fixEvidence: string | undefined,
): Promise<TurnCapture> {
  const cap: TurnCapture = { outcome: 'error', text: '' };
  const sink = captureSink(cap);
  const prompt = fixEvidence
    ? featureAgentFixPrompt(ctx.unit, fixEvidence)
    : featureAgentPrompt(ctx.unit);
  // The daemon executes the turn (session lifecycle + AgentLoop live there —
  // this package never imports @sunday/sundayd, see host.ts).
  await host.runSubAgent({
    title: `SUNDAY feature: ${ctx.unit.id} — ${ctx.unit.title}`,
    cwd: worktreePath,
    model: ctx.model,
    systemPrompt: featureAgentSystemPrompt(ctx.unit),
    prompt,
    tools: host.tools,
    maxIterations: Math.min(Math.max(ctx.unit.budget, 4), 60),
    signal: ctx.signal,
    onEvent: (event) => sink('', '', event),
  });
  return cap;
}

/** Working-tree diff of the slice, via the read-only git_diff tool. */
async function readWorktreeDiff(host: OrchestratorHost, worktreePath: string): Promise<string> {
  const r = await host.tools.call('git_diff', { path: '.' }, { cwd: worktreePath });
  const out = r.output || '(no diff)';
  return out.length > MAX_VERIFIER_DIFF_CHARS
    ? `${out.slice(0, MAX_VERIFIER_DIFF_CHARS)}\n…[diff truncated to ${MAX_VERIFIER_DIFF_CHARS} chars]`
    : out;
}

export interface Verdict {
  verdict: 'pass' | 'fail';
  evidence: string;
  failingCriterion?: string;
}

/**
 * Run the Verification Agent (ADR-16, §9.9.7): a SEPARATE, short-lived
 * session given ONLY the diff and the acceptance criteria — never the
 * Feature Agent's reasoning, history, or intermediate attempts. Read-only
 * tools by construction; it makes no fix decisions, only pass/fail.
 */
async function runVerifier(
  host: OrchestratorHost,
  ctx: UnitContext,
  worktreePath: string,
  diff: string,
): Promise<Verdict> {
  const verifierTools = scopedRegistry(host.tools, VERIFIER_TOOL_NAMES);

  const cap: TurnCapture = { outcome: 'error', text: '' };
  const sink = captureSink(cap);
  // The daemon executes the turn (session lifecycle + AgentLoop live there —
  // this package never imports @sunday/sundayd, see host.ts).
  await host.runSubAgent({
    title: `SUNDAY verifier: ${ctx.unit.id}`,
    cwd: worktreePath,
    model: ctx.model,
    systemPrompt: verifierSystemPrompt(),
    prompt: verifierPrompt(ctx.unit, diff),
    tools: verifierTools,
    maxIterations: 12,
    signal: ctx.signal,
    onEvent: (event) => sink('', '', event),
  });

  const start = cap.text.indexOf('{');
  const end = cap.text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const v = JSON.parse(cap.text.slice(start, end + 1)) as {
        verdict?: unknown;
        evidence?: unknown;
        failing_criterion?: unknown;
      };
      if (v.verdict === 'pass' || v.verdict === 'fail') {
        return {
          verdict: v.verdict,
          evidence: typeof v.evidence === 'string' && v.evidence ? v.evidence : '(no evidence given)',
          failingCriterion:
            typeof v.failing_criterion === 'string' ? v.failing_criterion : undefined,
        };
      }
    } catch {
      // fall through to the unparseable verdict below
    }
  }
  return {
    verdict: 'fail',
    evidence: `verifier returned an unparseable verdict: ${cap.text.slice(0, 500) || '(empty)'}`,
    failingCriterion: 'unparseable verifier verdict',
  };
}

async function runUnit(host: OrchestratorHost, ctx: UnitContext): Promise<UnitResult> {
  const branch = `sunday/feat/${sanitizeBranchId(ctx.unit.id)}`;
  const added = worktreeAddResultSchema.parse(
    await dispatchChecked(host, 'worktree/add', { repoRoot: ctx.workspaceRoot, branch }, 'worktree/add'),
  );
  ctx.notify(ctx.unit.id, 'started', `worktree ${added.path} · branch ${added.branch}`);

  let attempt = 0;
  let fixEvidence: string | undefined;
  // Initial attempt + FIXING re-delegations (§9.9.9).
  while (attempt <= MAX_UNIT_RETRIES) {
    attempt += 1;
    if (attempt > 1) {
      ctx.notify(ctx.unit.id, 'started', `retry ${attempt - 1}/${MAX_UNIT_RETRIES} — re-delegated with failure evidence`);
    }
    await runFeatureAgent(host, ctx, added.path, fixEvidence);
    const diff = await readWorktreeDiff(host, added.path);
    ctx.notify(ctx.unit.id, 'verifying', `attempt ${attempt}: checking ${ctx.unit.acceptance.length} criteria`);
    const verdict = await runVerifier(host, ctx, added.path, diff);

    if (verdict.verdict === 'pass') {
      const merged = worktreeMergeResultSchema.parse(
        await dispatchChecked(
          host,
          'worktree/merge',
          { repoRoot: ctx.workspaceRoot, path: added.path },
          'worktree/merge',
        ),
      );
      // Checkpoint after each successful merge (§16.1 reuse). Best-effort: a
      // checkpoint failure must never fail an already-merged unit.
      try {
        checkpointCreateResultSchema.parse(
          await host.dispatch('checkpoint/create', {
            workspaceRoot: ctx.workspaceRoot,
            label: `orchestrate/${ctx.runId}/${ctx.unit.id}`,
          }),
        );
      } catch (e) {
        ctx.notify(ctx.unit.id, 'merged', `sha ${merged.sha} → ${merged.target} (checkpoint skipped: ${(e as Error).message})`);
        return { id: ctx.unit.id, status: 'merged', sha: merged.sha };
      }
      ctx.notify(ctx.unit.id, 'merged', `sha ${merged.sha} → ${merged.target}`);
      return { id: ctx.unit.id, status: 'merged', sha: merged.sha };
    }

    // FIXING: failure evidence goes back to the SAME feature agent.
    fixEvidence = [
      `Failing criterion: ${verdict.failingCriterion ?? '(unspecified)'}`,
      `Evidence:\n${verdict.evidence}`,
    ].join('\n');
    if (attempt <= MAX_UNIT_RETRIES) {
      ctx.notify(ctx.unit.id, 'verifying', `failed: ${verdict.failingCriterion ?? 'criteria not met'} — sending back for fixing`);
    }
  }

  // Retries exhausted: mark failed, clean up the worktree, CONTINUE with the
  // next unit — one unit never blocks the whole run (§9.9.9).
  try {
    await host.dispatch('worktree/remove', {
      repoRoot: ctx.workspaceRoot,
      path: added.path,
      force: true,
    });
  } catch {
    // Cleanup is best-effort; the unit is failed either way.
  }
  ctx.notify(
    ctx.unit.id,
    'failed',
    `verification failed after ${MAX_UNIT_RETRIES} retries (${fixEvidence?.split('\n')[0] ?? 'no evidence'}) — continuing with next unit`,
  );
  return { id: ctx.unit.id, status: 'failed' };
}

export async function runOrchestration(
  host: OrchestratorHost,
  opts: RunOrchestrationOptions,
): Promise<OrchestrationRunResult> {
  const parsed = runParamsSchema.safeParse({
    goal: opts.goal,
    workspaceRoot: opts.workspaceRoot,
    model: opts.model,
    plan: opts.plan,
  });
  if (!parsed.success) {
    throw new OrchestrationError(
      'invalid-params',
      `orchestrate/run: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const modelRef = parsed.data.model ?? host.defaultModel;

  // ADR-18: the budget is estimated and surfaced BEFORE any delegation.
  // A caller-supplied plan is re-validated (overlap check included) — a
  // hand-made plan is never trusted blindly.
  const supplied = parsed.data.plan ? validatePlanUnits(parsed.data.plan) : undefined;
  const plan = supplied
    ? { units: supplied, totalBudget: estimateTotalBudget(supplied) }
    : await planGoal(host, { goal: parsed.data.goal, workspaceRoot: parsed.data.workspaceRoot, model: parsed.data.model, signal: opts.signal });

  const runId = randomUUID();
  const notify = (unitId: string, phase: OrchestrationPhase, detail?: string): void => {
    const event: OrchestrationEvent = { runId, unitId, phase };
    if (detail !== undefined) event.detail = detail;
    host.notify(event);
  };
  notify(
    '',
    'planned',
    `${plan.units.length} unit(s) · estimated ~${plan.totalBudget} model requests (budget surfaced before delegation, ADR-18)`,
  );

  // ADR-17: SEQUENTIAL-ONLY v1 — one unit at a time, in plan order.
  const results: UnitResult[] = [];
  let mergedSha: string | undefined;
  for (const unit of plan.units) {
    if (opts.signal?.aborted) {
      notify(unit.id, 'failed', 'run cancelled');
      results.push({ id: unit.id, status: 'failed' });
      continue;
    }
    const res = await runUnit(host, {
      runId,
      workspaceRoot: parsed.data.workspaceRoot,
      model: modelRef,
      unit,
      signal: opts.signal,
      notify,
    });
    results.push(res);
    if (res.status === 'merged' && res.sha) mergedSha = res.sha;
  }

  return runResultSchema.parse({ units: results, ...(mergedSha ? { mergedSha } : {}) });
}
