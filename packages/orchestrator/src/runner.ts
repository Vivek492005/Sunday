import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChatEvent } from '@sunday/protocol';
import { OrchestrationError } from './errors.js';
import type { OrchestratorHost } from './host.js';
import { findMergeConflicts, type UnitDiff } from './merge.js';
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
  type ConflictResolution,
  type MergeConflict,
  type OrchestrationEvent,
  type OrchestrationPhase,
  type OrchestrationRunResult,
  type OrchestrationRunState,
  type PlannedUnit,
  type UnitResult,
  type UnitRunState,
  type UnitRunStatus,
} from './schemas.js';
import {
  getDefaultOrchestrationStore,
  getOrchestrationRunState,
  trackRunState,
  type FileOrchestrationStateStore,
} from './state.js';
import { checkUnitsOverlap } from './overlap.js';
import { VERIFIER_TOOL_NAMES, scopedRegistry } from './toolscope.js';

/**
 * `orchestrate/run` (§9.9.5, §9.9.9) — sequential v1 (ADR-17) plus the
 * Parallel Agents mode.
 *
 * SEQUENTIAL (default): for each contracted unit in order —
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
 * PARALLEL (`parallel: true`): units run concurrently in a bounded pool
 * (default 3). Each unit gets its own worktree and the same
 * feature-agent + verifier-retry flow, but merging moves to a SEPARATE
 * phase after all units settle: diffs are collected, textual overlap between
 * units' hunks is detected (→ 'conflicted', never auto-resolved), and only
 * clean plans merge in plan order via `worktree/merge` + checkpoint. A final
 * single verification pass runs over the merged result.
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
  /** Parallel mode: bounded-pool concurrent units + deferred merge phase.
   *  Default false — the sequential path is unchanged when false. */
  parallel?: boolean;
  /** Pool size for parallel mode. Default 3. */
  maxParallel?: number;
  /** Run-state persistence. Defaults to ~/.sunday/orchestrations. Tests MUST
   *  pass a temp-dir store. */
  store?: FileOrchestrationStateStore;
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
  /** Parallel-mode state tracking hook (absent in the sequential path). */
  setUnitStatus?: (status: UnitRunStatus) => void;
}

type TurnOutcome = 'stop' | 'max-steps' | 'error' | 'cancelled';

interface TurnCapture {
  outcome: TurnOutcome;
  /** Assistant text accumulated over the turn (tail-kept). */
  text: string;
}

/** Thrown when a unit's AbortSignal fires mid-flight (parallel mode). */
class UnitCancelledError extends Error {
  constructor(readonly unitId: string) {
    super(`unit ${unitId} cancelled`);
    this.name = 'UnitCancelledError';
  }
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

interface UnitWorkOutcome {
  /** 'done' = verified pass (worktree left on disk for the merge phase);
   *  'failed' = retries exhausted. */
  outcome: 'done' | 'failed';
  /** Failing evidence when 'failed'. */
  evidence?: string;
}

function failureDetail(evidence: string | undefined): string {
  return `verification failed after ${MAX_UNIT_RETRIES} retries (${evidence?.split('\n')[0] ?? 'no evidence'}) — continuing with next unit`;
}

/**
 * The per-unit work loop shared by both paths: feature agent + verifier
 * retries (FIXING re-delegation, §9.9.9). Worktree creation, merging, and
 * cleanup are the CALLER's job — this function only runs the agent/verify
 * attempts against an already-added worktree. Throws UnitCancelledError when
 * the unit's signal fires.
 */
async function runUnitAttempts(
  host: OrchestratorHost,
  ctx: UnitContext,
  worktreePath: string,
): Promise<UnitWorkOutcome> {
  let attempt = 0;
  let fixEvidence: string | undefined;
  // Initial attempt + FIXING re-delegations (§9.9.9).
  while (attempt <= MAX_UNIT_RETRIES) {
    attempt += 1;
    if (ctx.signal?.aborted) throw new UnitCancelledError(ctx.unit.id);
    if (attempt > 1) {
      ctx.notify(ctx.unit.id, 'started', `retry ${attempt - 1}/${MAX_UNIT_RETRIES} — re-delegated with failure evidence`);
    }
    await runFeatureAgent(host, ctx, worktreePath, fixEvidence);
    const diff = await readWorktreeDiff(host, worktreePath);
    ctx.setUnitStatus?.('verifying');
    ctx.notify(ctx.unit.id, 'verifying', `attempt ${attempt}: checking ${ctx.unit.acceptance.length} criteria`);
    const verdict = await runVerifier(host, ctx, worktreePath, diff);

    if (verdict.verdict === 'pass') {
      return { outcome: 'done' };
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

  // Retries exhausted — the caller marks the unit failed and cleans up the
  // worktree (sequential: continue with the next unit; parallel: merge phase
  // skips failed units). One unit never blocks the whole run (§9.9.9).
  return { outcome: 'failed', evidence: fixEvidence };
}

/**
 * Merge one unit's worktree via `worktree/merge` + `checkpoint/create`
 * (the sequential merge logic, reused by the parallel merge phase).
 *
 * Merge is a WRITE op: it goes through the daemon's `worktree/merge`, which
 * the daemon's policy gate approves (same as today). The `mergeWriteTag`
 * option prefixes the event detail with `merge-write` so clients can tell
 * main-workspace writes apart from unit-local work.
 */
async function mergeUnitWorktree(
  host: OrchestratorHost,
  ctx: UnitContext,
  worktreePath: string,
  opts?: { mergeWriteTag?: boolean },
): Promise<{ sha: string }> {
  const merged = worktreeMergeResultSchema.parse(
    await dispatchChecked(
      host,
      'worktree/merge',
      { repoRoot: ctx.workspaceRoot, path: worktreePath },
      'worktree/merge',
    ),
  );
  const tag = opts?.mergeWriteTag ? 'merge-write · ' : '';
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
    ctx.notify(ctx.unit.id, 'merged', `${tag}sha ${merged.sha} → ${merged.target} (checkpoint skipped: ${(e as Error).message})`);
    return { sha: merged.sha };
  }
  ctx.notify(ctx.unit.id, 'merged', `${tag}sha ${merged.sha} → ${merged.target}`);
  return { sha: merged.sha };
}

async function runUnit(host: OrchestratorHost, ctx: UnitContext): Promise<UnitResult> {
  const branch = `sunday/feat/${sanitizeBranchId(ctx.unit.id)}`;
  const added = worktreeAddResultSchema.parse(
    await dispatchChecked(host, 'worktree/add', { repoRoot: ctx.workspaceRoot, branch }, 'worktree/add'),
  );
  ctx.notify(ctx.unit.id, 'started', `worktree ${added.path} · branch ${added.branch}`);

  const outcome = await runUnitAttempts(host, ctx, added.path);
  if (outcome.outcome === 'done') {
    const { sha } = await mergeUnitWorktree(host, ctx, added.path);
    return { id: ctx.unit.id, status: 'merged', sha };
  }

  try {
    await host.dispatch('worktree/remove', {
      repoRoot: ctx.workspaceRoot,
      path: added.path,
      force: true,
    });
  } catch {
    // Cleanup is best-effort; the unit is failed either way.
  }
  ctx.notify(ctx.unit.id, 'failed', failureDetail(outcome.evidence));
  return { id: ctx.unit.id, status: 'failed' };
}

/* ---- Parallel mode: active-run registry, merge phase, cancellation ---- */

interface ActiveRunEntry {
  /** Run-level abort: cancelling aborts every in-flight unit. */
  controller: AbortController;
  /** Per-unit controllers (one unit's abort never touches the others). */
  units: Map<string, AbortController>;
  /** Persist current state (parallel runs only). */
  persist?: () => Promise<void>;
  /** Best-effort worktree/remove for every tracked worktree. */
  cleanupWorktrees?: () => Promise<void>;
}

/** Module-level active-runs registry: runId → abort + cleanup handles. */
const activeRuns = new Map<string, ActiveRunEntry>();

/**
 * Everything needed to resume a 'conflicted' run after resolveRunConflicts.
 * Kept in-process only (conflicted runs keep their worktrees on disk, but
 * resuming requires the originating process — noted in the report).
 */
interface SuspendedRun {
  host: OrchestratorHost;
  store: FileOrchestrationStateStore;
  state: OrchestrationRunState;
  plan: PlannedUnit[];
  modelRef: string;
  workspaceRoot: string;
  goal: string;
  runController: AbortController;
  entry: ActiveRunEntry;
  notify: (unitId: string, phase: OrchestrationPhase, detail?: string) => void;
  /** Merge SHAs recorded by runMergePhase (unit id → sha), in plan order. */
  mergeSha?: Map<string, string>;
}

const suspendedRuns = new Map<string, SuspendedRun>();

function unitStateOf(state: OrchestrationRunState, unitId: string): UnitRunState {
  const u = state.units.find((x) => x.id === unitId);
  if (!u) throw new OrchestrationError('invalid-state', `run ${state.runId}: no unit state for ${unitId}`);
  return u;
}

type FinalUnitStatus = 'merged' | 'failed' | 'cancelled';

function buildUnitResults(
  plan: PlannedUnit[],
  workOutcome: Map<string, 'done' | 'failed' | 'cancelled'>,
  mergeSha: Map<string, string>,
): UnitResult[] {
  return plan.map((u) => {
    const o = workOutcome.get(u.id) ?? 'failed';
    if (o === 'done') {
      const sha = mergeSha.get(u.id);
      // 'done' without a sha only if the merge phase blew up mid-way.
      return sha ? { id: u.id, status: 'merged' as const, sha } : { id: u.id, status: 'failed' as const };
    }
    return { id: u.id, status: o as FinalUnitStatus };
  });
}

/**
 * The deferred merge phase (parallel mode): collect diffs → detect textual
 * conflicts → merge in plan order → verify once over the merged result.
 *
 * Returns the conflicts found (empty when clean) and the merged unit ids in
 * plan order. On conflicts the run is persisted as 'conflicted', NOTHING is
 * merged, and the caller suspends the run for resolveRunConflicts.
 */
async function runMergePhase(s: SuspendedRun): Promise<{ conflicts: MergeConflict[]; merged: string[] }> {
  const { host, store, state, plan, modelRef, workspaceRoot, runController, notify } = s;
  const touch = async (): Promise<void> => {
    state.updatedAt = new Date().toISOString();
    trackRunState(state);
    await store.save(state);
  };
  const successful = plan.filter((u) => unitStateOf(state, u.id).status === 'done');

  // 1. Collect every successful unit's diff BEFORE merging anything.
  const diffs: UnitDiff[] = [];
  for (const u of successful) {
    const wt = unitStateOf(state, u.id).worktreePath;
    if (!wt) throw new OrchestrationError('invalid-state', `run ${state.runId}: unit ${u.id} has no worktree`);
    diffs.push({ unitId: u.id, diff: await readWorktreeDiff(host, wt) });
  }

  // 2. Textual conflict detection: same file + overlapping old-line ranges +
  //    differing new-side content → MergeConflict. Never auto-resolved.
  const conflicts = findMergeConflicts(diffs);
  if (conflicts.length > 0) {
    state.status = 'conflicted';
    state.conflicts = conflicts;
    await touch();
    notify('', 'conflicted', JSON.stringify(conflicts).slice(0, 2000));
    return { conflicts, merged: [] };
  }
  state.conflicts = [];

  // 3. Clean: merge each unit in plan order via worktree/merge (+ checkpoint).
  const merged: string[] = [];
  const mergedDiffs: string[] = [];
  const mergeSha = new Map<string, string>();
  s.mergeSha = mergeSha;
  for (const u of successful) {
    const us = unitStateOf(state, u.id);
    const ctx: UnitContext = {
      runId: state.runId,
      workspaceRoot,
      model: modelRef,
      unit: u,
      signal: runController.signal,
      notify,
    };
    const { sha } = await mergeUnitWorktree(host, ctx, us.worktreePath!, { mergeWriteTag: true });
    us.sha = sha;
    mergeSha.set(u.id, sha);
    merged.push(u.id);
    mergedDiffs.push(diffs.find((d) => d.unitId === u.id)?.diff ?? '');
    await touch();
    // The branch is merged; drop the worktree (best-effort).
    try {
      await host.dispatch('worktree/remove', { repoRoot: workspaceRoot, path: us.worktreePath, force: true });
    } catch {
      // best-effort
    }
  }

  // 4. Verifier runs ONCE over the merged result (v1: no re-delegation on
  //    failure — the run is marked 'failed' with the evidence).
  const verifyUnit: PlannedUnit = {
    id: 'merged-result',
    title: 'final verification of the merged result',
    owns_paths: ['**'],
    acceptance: successful.flatMap((u) => u.acceptance),
    budget: 12,
  };
  const mergedDiff = mergedDiffs.join('\n').slice(0, MAX_VERIFIER_DIFF_CHARS);
  notify('', 'verifying', 'final verification of the merged result (one pass; no re-delegation in parallel v1)');
  const vctx: UnitContext = {
    runId: state.runId,
    workspaceRoot,
    model: modelRef,
    unit: verifyUnit,
    signal: runController.signal,
    notify,
  };
  const verdict = await runVerifier(host, vctx, workspaceRoot, mergedDiff);
  if (verdict.verdict === 'fail') {
    state.status = 'failed';
    await touch();
    notify(
      '',
      'failed',
      `final verification of the merged result failed: ${verdict.failingCriterion ?? 'criteria not met'} — ${verdict.evidence}`.slice(0, 2000),
    );
    return { conflicts: [], merged };
  }

  state.status = 'done';
  await touch();
  notify('', 'merged', `merge-write · ${merged.length} unit(s) merged in plan order · final verification passed`);
  return { conflicts: [], merged };
}

async function runOrchestrationParallel(
  host: OrchestratorHost,
  opts: RunOrchestrationOptions,
  args: {
    goal: string;
    workspaceRoot: string;
    plan: { units: PlannedUnit[]; totalBudget: number };
    modelRef: string;
    runController: AbortController;
  },
): Promise<OrchestrationRunResult> {
  const { goal, workspaceRoot, plan, modelRef, runController } = args;

  // Overlap gate: parallel mode REFUSES overlapping plans. validatePlanUnits
  // already ran checkUnitsOverlap (fail-fast `plan-overlap`), and the planner
  // path runs it too — this explicit re-check makes it impossible for a
  // future refactor to dispatch overlapping units concurrently.
  checkUnitsOverlap(plan.units);

  const store = opts.store ?? getDefaultOrchestrationStore();
  await store.init();
  const maxParallel = Math.min(Math.max(opts.maxParallel ?? 3, 1), plan.units.length);
  const runId = randomUUID();
  const nowIso = (): string => new Date().toISOString();
  const state: OrchestrationRunState = {
    runId,
    goal,
    parallel: true,
    status: 'running',
    units: plan.units.map((u) => ({
      id: u.id,
      title: u.title,
      status: 'queued' as UnitRunStatus,
      model: modelRef,
    })),
    conflicts: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const persist = async (): Promise<void> => {
    state.updatedAt = nowIso();
    trackRunState(state);
    await store.save(state);
  };
  await persist();

  const notify = (unitId: string, phase: OrchestrationPhase, detail?: string): void => {
    const event: OrchestrationEvent = { runId, unitId, phase };
    if (detail !== undefined) event.detail = detail;
    host.notify(event);
  };
  notify(
    '',
    'planned',
    `${plan.units.length} unit(s) · parallel mode (pool of ${maxParallel}) · estimated ~${plan.totalBudget} model requests (budget surfaced before delegation, ADR-18)`,
  );

  const entry: ActiveRunEntry = {
    controller: runController,
    units: new Map(),
    persist,
    cleanupWorktrees: async () => {
      for (const u of state.units) {
        if (!u.worktreePath) continue;
        try {
          await host.dispatch('worktree/remove', { repoRoot: workspaceRoot, path: u.worktreePath, force: true });
        } catch {
          // best-effort
        }
      }
    },
  };
  activeRuns.set(runId, entry);

  const workOutcome = new Map<string, 'done' | 'failed' | 'cancelled'>();
  const worktreeByUnit = new Map<string, string>();
  const queue = [...plan.units];
  // Units beyond the first pool batch wait for a slot: emit 'queued'.
  plan.units.forEach((u, i) => {
    if (i >= maxParallel) notify(u.id, 'queued', `waiting for a pool slot (max ${maxParallel} concurrent)`);
  });

  async function runOne(unit: PlannedUnit): Promise<void> {
    const ustate = unitStateOf(state, unit.id);
    // Per-unit AbortController: one unit's failure/cancel never kills others.
    const uc = new AbortController();
    entry.units.set(unit.id, uc);
    const onRunAbort = (): void => uc.abort();
    runController.signal.addEventListener('abort', onRunAbort, { once: true });
    try {
      if (runController.signal.aborted) throw new UnitCancelledError(unit.id);
      ustate.status = 'running';
      await persist();
      const ctx: UnitContext = {
        runId,
        workspaceRoot,
        model: modelRef,
        unit,
        signal: uc.signal,
        notify,
        setUnitStatus: (s) => {
          ustate.status = s;
        },
      };
      const branch = `sunday/feat/${sanitizeBranchId(unit.id)}`;
      const added = worktreeAddResultSchema.parse(
        await dispatchChecked(host, 'worktree/add', { repoRoot: workspaceRoot, branch }, 'worktree/add'),
      );
      ustate.worktreePath = added.path;
      worktreeByUnit.set(unit.id, added.path);
      await persist();
      ctx.notify(unit.id, 'started', `worktree ${added.path} · branch ${added.branch}`);

      const outcome = await runUnitAttempts(host, ctx, added.path);
      if (outcome.outcome === 'done') {
        ustate.status = 'done';
        workOutcome.set(unit.id, 'done');
        await persist();
        return;
      }
      // Failed: clean up the worktree, record, CONTINUE (others unaffected).
      ustate.status = 'failed';
      ustate.error = outcome.evidence;
      workOutcome.set(unit.id, 'failed');
      try {
        await host.dispatch('worktree/remove', { repoRoot: workspaceRoot, path: added.path, force: true });
      } catch {
        // best-effort
      }
      ctx.notify(unit.id, 'failed', failureDetail(outcome.evidence));
      await persist();
    } catch (e) {
      const cancelled =
        e instanceof UnitCancelledError || uc.signal.aborted || runController.signal.aborted;
      ustate.status = cancelled ? 'cancelled' : 'failed';
      if (!cancelled) ustate.error = (e as Error).message;
      workOutcome.set(unit.id, cancelled ? 'cancelled' : 'failed');
      const wt = worktreeByUnit.get(unit.id);
      if (wt) {
        try {
          await host.dispatch('worktree/remove', { repoRoot: workspaceRoot, path: wt, force: true });
        } catch {
          // best-effort
        }
      }
      ctxNotifySafe(notify, unit.id, cancelled ? 'run cancelled' : `error: ${(e as Error).message}`);
      await persist().catch(() => undefined);
    } finally {
      runController.signal.removeEventListener('abort', onRunAbort);
      entry.units.delete(unit.id);
    }
  }

  // Bounded pool: at most maxParallel units in flight.
  const workers = Array.from({ length: Math.min(maxParallel, queue.length) }, async () => {
    for (;;) {
      const unit = queue.shift();
      if (!unit) return;
      await runOne(unit); // never throws: runOne catches everything
    }
  });
  await Promise.all(workers);

  // Cancellation wins over the merge phase.
  if (runController.signal.aborted) {
    state.status = 'cancelled';
    for (const u of state.units) {
      if (u.status === 'queued' || u.status === 'running' || u.status === 'verifying') {
        u.status = 'cancelled';
      }
    }
    await entry.cleanupWorktrees?.().catch(() => undefined);
    await persist().catch(() => undefined);
    activeRuns.delete(runId);
    return runResultSchema.parse({ units: buildUnitResults(plan.units, workOutcome, new Map()) });
  }

  const successful = plan.units.filter((u) => workOutcome.get(u.id) === 'done');
  if (successful.length === 0) {
    state.status = 'failed';
    await persist().catch(() => undefined);
    activeRuns.delete(runId);
    notify('', 'failed', 'no unit verified — nothing to merge');
    return runResultSchema.parse({ units: buildUnitResults(plan.units, workOutcome, new Map()) });
  }

  const suspended: SuspendedRun = {
    host,
    store,
    state,
    plan: plan.units,
    modelRef,
    workspaceRoot,
    goal,
    runController,
    entry,
    notify,
  };
  try {
    await runMergePhase(suspended);
  } catch (e) {
    state.status = 'failed';
    state.updatedAt = nowIso();
    trackRunState(state);
    await store.save(state).catch(() => undefined);
    notify('', 'failed', `merge phase failed: ${(e as Error).message}`.slice(0, 2000));
  }
  activeRuns.delete(runId);
  if (state.status === 'conflicted') {
    // Worktrees are kept on disk; the run suspends awaiting resolveRunConflicts.
    suspendedRuns.set(runId, suspended);
  }
  const mergeSha = suspended.mergeSha ?? new Map<string, string>();
  const shas = state.units.map((u) => u.sha).filter((s): s is string => !!s);
  return runResultSchema.parse({
    units: buildUnitResults(plan.units, workOutcome, mergeSha),
    ...(shas.length > 0 ? { mergedSha: shas[shas.length - 1] } : {}),
  });
}

function ctxNotifySafe(
  notify: (unitId: string, phase: OrchestrationPhase, detail?: string) => void,
  unitId: string,
  detail: string,
): void {
  try {
    notify(unitId, 'failed', detail);
  } catch {
    // notify is best-effort during teardown
  }
}

/**
 * Stop a running orchestration: aborts in-flight units, best-effort
 * `worktree/remove` cleanup, marks non-terminal units 'cancelled'. Returns
 * `{ stopped: false }` when the runId isn't an active run.
 */
export async function cancelOrchestrationRun(runId: string): Promise<{ stopped: boolean }> {
  const entry = activeRuns.get(runId);
  if (!entry) return { stopped: false };
  entry.controller.abort();
  for (const uc of entry.units.values()) {
    try {
      uc.abort();
    } catch {
      // ignore
    }
  }
  activeRuns.delete(runId);
  const state = getOrchestrationRunState(runId);
  if (state) {
    if (state.status === 'running') {
      state.status = 'cancelled';
      for (const u of state.units) {
        if (u.status === 'queued' || u.status === 'running' || u.status === 'verifying') {
          u.status = 'cancelled';
        }
      }
      state.updatedAt = new Date().toISOString();
    }
    if (entry.cleanupWorktrees) {
      try {
        await entry.cleanupWorktrees();
      } catch {
        // best-effort
      }
    }
    if (entry.persist) {
      try {
        await entry.persist();
      } catch {
        // best-effort
      }
    } else {
      try {
        await getDefaultOrchestrationStore().save(state);
      } catch {
        // best-effort
      }
    }
  }
  return { stopped: true };
}

// Re-export the state API through the runner for a single import surface.
export {
  getOrchestrationRunState,
  listOrchestrationRuns,
  reconcileOrchestrationRuns,
  FileOrchestrationStateStore,
  defaultOrchestrationsDir,
} from './state.js';

/**
 * Apply human (or RPC) conflict resolutions to a 'conflicted' run, then
 * re-run the merge phase for the remaining units and continue to the final
 * verification.
 *
 * Each `{ conflictIndex, keepUnitId }` resolves one conflict: the conflicted
 * file's FULL content is taken from keepUnitId's worktree and written into
 * every other party's worktree for that file. The two units' hunks then
 * become identical, which the detector treats as merge-clean (git merges
 * duplicate changes without conflict).
 *
 * The resolution copy stays inside unit worktrees — the same trust domain
 * the feature agents already write to. The only main-workspace write is the
 * subsequent `worktree/merge`, which the daemon's policy gate approves (see
 * mergeUnitWorktree).
 *
 * If conflicts remain after applying the resolutions, the run stays
 * 'conflicted' (persisted, worktrees kept) and the caller can resolve again.
 */
export async function resolveRunConflicts(
  runId: string,
  resolutions: ConflictResolution[],
): Promise<void> {
  const s = suspendedRuns.get(runId);
  if (!s) {
    throw new OrchestrationError(
      'unknown-run',
      `no suspended (conflicted) run: ${runId} — resolution requires the originating process`,
    );
  }
  const { state, notify } = s;
  if (state.status !== 'conflicted') {
    throw new OrchestrationError(
      'invalid-state',
      `run ${runId} is '${state.status}', not 'conflicted'`,
    );
  }
  if (!Array.isArray(resolutions) || resolutions.length === 0) {
    throw new OrchestrationError('invalid-params', 'resolveRunConflicts: at least one resolution is required');
  }

  // Validate everything before touching any worktree.
  for (const r of resolutions) {
    const conflict = state.conflicts.find((c) => c.index === r.conflictIndex);
    if (!conflict) {
      throw new OrchestrationError('invalid-params', `unknown conflict index ${r.conflictIndex}`);
    }
    const parties = new Set(conflict.hunks.flatMap((h) => [h.unitA, h.unitB]));
    if (!parties.has(r.keepUnitId)) {
      throw new OrchestrationError(
        'invalid-params',
        `keepUnitId '${r.keepUnitId}' is not party to conflict #${r.conflictIndex}`,
      );
    }
  }

  for (const r of resolutions) {
    const conflict = state.conflicts.find((c) => c.index === r.conflictIndex)!;
    const keep = unitStateOf(state, r.keepUnitId);
    if (!keep.worktreePath) {
      throw new OrchestrationError('invalid-state', `unit ${r.keepUnitId} has no worktree`);
    }
    let content: string;
    try {
      content = await fsp.readFile(path.join(keep.worktreePath, conflict.file), 'utf8');
    } catch (e) {
      throw new OrchestrationError(
        'resolve-failed',
        `cannot read ${conflict.file} from ${r.keepUnitId}'s worktree: ${(e as Error).message}`,
      );
    }
    const parties = new Set(conflict.hunks.flatMap((h) => [h.unitA, h.unitB]));
    for (const pid of parties) {
      if (pid === r.keepUnitId) continue;
      const other = unitStateOf(state, pid);
      if (!other.worktreePath) continue;
      const target = path.join(other.worktreePath, conflict.file);
      try {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, content);
      } catch (e) {
        throw new OrchestrationError(
          'resolve-failed',
          `cannot write ${conflict.file} into ${pid}'s worktree: ${(e as Error).message}`,
        );
      }
    }
    notify(r.keepUnitId, 'started', `conflict #${r.conflictIndex} resolved: kept ${r.keepUnitId}'s ${conflict.file}`);
  }

  // Re-run the merge phase; any remaining conflicts re-suspend the run.
  activeRuns.set(runId, s.entry);
  try {
    await runMergePhase(s);
  } finally {
    activeRuns.delete(runId);
  }
  if (state.status !== 'conflicted') {
    suspendedRuns.delete(runId);
  }
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

  // Run-level abort: mirrors opts.signal so cancelOrchestrationRun can stop
  // the run even without the caller's signal.
  const runController = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) runController.abort();
    else opts.signal.addEventListener('abort', () => runController.abort(), { once: true });
  }

  // ADR-18: the budget is estimated and surfaced BEFORE any delegation.
  // A caller-supplied plan is re-validated (overlap check included) — a
  // hand-made plan is never trusted blindly.
  const supplied = parsed.data.plan ? validatePlanUnits(parsed.data.plan) : undefined;
  const plan = supplied
    ? { units: supplied, totalBudget: estimateTotalBudget(supplied) }
    : await planGoal(host, { goal: parsed.data.goal, workspaceRoot: parsed.data.workspaceRoot, model: parsed.data.model, signal: runController.signal });

  if (opts.parallel ?? false) {
    return runOrchestrationParallel(host, opts, {
      goal: parsed.data.goal,
      workspaceRoot: parsed.data.workspaceRoot,
      plan,
      modelRef,
      runController,
    });
  }

  const runId = randomUUID();
  // Register the sequential run too, so cancelOrchestrationRun can abort it
  // mid-flight (the loop below already polls the mirrored signal).
  activeRuns.set(runId, { controller: runController, units: new Map() });
  try {
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
      if (runController.signal.aborted) {
        notify(unit.id, 'failed', 'run cancelled');
        results.push({ id: unit.id, status: 'failed' });
        continue;
      }
      let res: UnitResult;
      try {
        res = await runUnit(host, {
          runId,
          workspaceRoot: parsed.data.workspaceRoot,
          model: modelRef,
          unit,
          signal: runController.signal,
          notify,
        });
      } catch (e) {
        // Cancellation (via cancelOrchestrationRun) settles the run: the unit
        // is marked failed and the loop's abort check marks the rest.
        // Unexpected errors still propagate, exactly as before.
        if (e instanceof UnitCancelledError || runController.signal.aborted) {
          notify(unit.id, 'failed', 'run cancelled');
          results.push({ id: unit.id, status: 'failed' });
          continue;
        }
        throw e;
      }
      results.push(res);
      if (res.status === 'merged' && res.sha) mergedSha = res.sha;
    }

    return runResultSchema.parse({ units: results, ...(mergedSha ? { mergedSha } : {}) });
  } finally {
    activeRuns.delete(runId);
  }
}
