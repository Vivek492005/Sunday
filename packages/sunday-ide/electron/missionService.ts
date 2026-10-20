/**
 * Sunday IDE — missionService.ts (Mission Control)
 *
 * Kanban-over-orchestrator state layer in the Electron main process.
 * Every mission is planned / run / tracked through the REAL sundayd
 * daemon RPCs (`orchestrate/plan|run|status|stop` + the
 * `orchestrate/event` notification). No mocks, no fake plans: when the
 * daemon is down the mission is persisted with status 'error' and the
 * real error message.
 *
 * Persistence: `~/.sunday-ide/missions.json`, atomic tmp+rename writes,
 * never throws on load (corrupt file → empty list).
 *
 * Event correlation rule (v1)
 * ---------------------------
 * `orchestrate/run` is a LONG-RUNNING RPC: it resolves only when the run
 * finishes, so it does NOT return a runId up-front. The runId arrives
 * via `orchestrate/event` notifications (and status polling once known).
 * Mission Control allows only ONE run in flight at a time (startMission
 * throws 'another mission is already running' when one is queued /
 * running — sequential execution is explicit and honest). Therefore:
 * the FIRST `orchestrate/event` carrying an unknown runId binds that
 * runId to the single in-flight mission (the one mission in status
 * 'queued' or 'running' that has no runId yet). Once bound, later events
 * match by runId directly. Events with an unknown runId and no
 * bindable in-flight mission are dropped (nothing honest to attach
 * them to). Events are the live log; `orchestrate/status` remains the
 * source of truth for unit/run state.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { daemonRpc as realDaemonRpc, addNotificationHandler as realAddNotificationHandler } from './daemonClient.js';

// ---------------------------------------------------------------------------
// Types (mirror of @sunday/protocol orchestrate shapes — kept local so the
// preload / renderer can mirror them without importing the protocol pkg)
// ---------------------------------------------------------------------------

export interface PlannedUnit {
  id: string;
  title: string;
  owns_paths: string[];
  acceptance: string[];
  budget: number;
}

export interface MissionPlan {
  units: PlannedUnit[];
  totalBudget: number;
}

export type UnitRunStatus = 'queued' | 'running' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface UnitRunState {
  id: string;
  title: string;
  status: UnitRunStatus;
  worktreePath?: string;
  model?: string;
  steps?: number;
  sha?: string;
  error?: string;
}

export type MissionStatus =
  | 'planned'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'error';

export interface MissionLogEntry {
  ts: string;
  unitId?: string;
  phase: string;
  detail?: string;
}

export interface Mission {
  id: string;
  goal: string;
  model?: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  status: MissionStatus;
  runId?: string;
  plan?: MissionPlan;
  units?: UnitRunState[];
  logTail: MissionLogEntry[];
  error?: string;
}

export interface CreateMissionInput {
  goal: string;
  model?: string;
  workspaceRoot: string;
}

export interface MissionsFile {
  missions: Mission[];
}

// ---------------------------------------------------------------------------
// Caps (SAFETY: nothing in this module grows without bound)
// ---------------------------------------------------------------------------

export const LOG_TAIL_CAP = 200;
export const MAX_MISSIONS = 100;

const TERMINAL_STATUSES: MissionStatus[] = ['done', 'failed', 'stopped', 'error'];
const ORCHESTRATE_PHASES = [
  'planned',
  'queued',
  'started',
  'verifying',
  'merged',
  'failed',
  'conflicted',
] as const;

// ---------------------------------------------------------------------------
// Injectable deps (tests stub the daemon RPC + point at a temp file)
// ---------------------------------------------------------------------------

export type DaemonRpcFn = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
export type AddNotificationHandlerFn = (method: string, handler: (params: unknown) => void) => void;

export interface MissionServiceDeps {
  rpc?: DaemonRpcFn;
  addNotificationHandler?: AddNotificationHandlerFn;
  /** Explicit state-file path (wins over homeDir). */
  filePath?: string;
  /** Home dir override — state file becomes `<homeDir>/.sunday-ide/missions.json`. */
  homeDir?: string;
  now?: () => Date;
}

export interface MissionService {
  listMissions(): Promise<Mission[]>;
  createMission(input: CreateMissionInput): Promise<Mission>;
  startMission(id: string): Promise<Mission>;
  refreshMission(id: string): Promise<Mission>;
  stopMission(id: string): Promise<Mission>;
  handleOrchestrateEvent(params: unknown): void;
  initMissionService(): void;
  missionsFilePath(): string;
}

// ---------------------------------------------------------------------------
// Small validation helpers (daemon payloads are trusted-but-verified)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function asPlannedUnit(v: unknown): PlannedUnit | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== 'string' || typeof v.title !== 'string') return null;
  return {
    id: v.id,
    title: v.title,
    owns_paths: Array.isArray(v.owns_paths) ? v.owns_paths.filter((x): x is string => typeof x === 'string') : [],
    acceptance: Array.isArray(v.acceptance) ? v.acceptance.filter((x): x is string => typeof x === 'string') : [],
    budget: typeof v.budget === 'number' ? v.budget : 0,
  };
}

function asUnitRunState(v: unknown): UnitRunState | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== 'string' || typeof v.title !== 'string') return null;
  const status = typeof v.status === 'string' ? v.status : 'queued';
  const allowed: UnitRunStatus[] = ['queued', 'running', 'verifying', 'done', 'failed', 'cancelled'];
  return {
    id: v.id,
    title: v.title,
    status: (allowed as string[]).includes(status) ? (status as UnitRunStatus) : 'queued',
    ...(typeof v.worktreePath === 'string' ? { worktreePath: v.worktreePath } : {}),
    ...(typeof v.model === 'string' ? { model: v.model } : {}),
    ...(typeof v.steps === 'number' ? { steps: v.steps } : {}),
    ...(typeof v.sha === 'string' ? { sha: v.sha } : {}),
    ...(typeof v.error === 'string' ? { error: v.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMissionService(deps: MissionServiceDeps = {}): MissionService {
  const rpc: DaemonRpcFn = deps.rpc ?? ((m, p, t) => realDaemonRpc(m, p, t));
  const addHandler: AddNotificationHandlerFn = deps.addNotificationHandler ?? realAddNotificationHandler;
  const now = deps.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();
  let initialized = false;

  function missionsFilePath(): string {
    if (deps.filePath) return deps.filePath;
    const home = deps.homeDir ?? os.homedir();
    return path.join(home, '.sunday-ide', 'missions.json');
  }

  // -- persistence (sync IO: the event handler is a sync callback, and
  //    sync load/save keeps concurrent mutations race-free) -------------

  function loadStore(): MissionsFile {
    const file = missionsFilePath();
    try {
      if (!fs.existsSync(file)) return { missions: [] };
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isRecord(parsed) || !Array.isArray(parsed.missions)) return { missions: [] };
      const missions: Mission[] = [];
      for (const raw of parsed.missions) {
        if (!isRecord(raw)) continue;
        if (typeof raw.id !== 'string' || typeof raw.goal !== 'string') continue;
        const mission = raw as unknown as Mission;
        // Defensive: a hand-edited / corrupt entry may lack a log tail.
        if (!Array.isArray(mission.logTail)) mission.logTail = [];
        missions.push(mission);
      }
      return { missions };
    } catch {
      // Corrupt → empty. Never throw on load.
      return { missions: [] };
    }
  }

  function pruneMissions(missions: Mission[]): Mission[] {
    let out = [...missions];
    // Newest first is the stored order; oldest sit at the tail.
    while (out.length > MAX_MISSIONS) {
      // Drop oldest terminal ones first …
      let dropIdx = -1;
      for (let i = out.length - 1; i >= 0; i--) {
        if (TERMINAL_STATUSES.includes(out[i].status)) {
          dropIdx = i;
          break;
        }
      }
      // … and only if none are terminal, drop the oldest overall.
      if (dropIdx === -1) dropIdx = out.length - 1;
      out = [...out.slice(0, dropIdx), ...out.slice(dropIdx + 1)];
    }
    return out;
  }

  function saveStore(store: MissionsFile): void {
    const file = missionsFilePath();
    const pruned: MissionsFile = { missions: pruneMissions(store.missions) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function appendLog(mission: Mission, entry: MissionLogEntry): void {
    mission.logTail = [...(mission.logTail ?? []), entry].slice(-LOG_TAIL_CAP);
  }

  function persistMission(mission: Mission): Mission {
    const store = loadStore();
    const idx = store.missions.findIndex((m) => m.id === mission.id);
    mission.updatedAt = nowIso();
    if (idx >= 0) store.missions[idx] = mission;
    else store.missions.unshift(mission);
    saveStore(store);
    return mission;
  }

  function findMission(id: string): { store: MissionsFile; mission: Mission } {
    const store = loadStore();
    const mission = store.missions.find((m) => m.id === id);
    if (!mission) throw new Error(`mission not found: ${id}`);
    return { store, mission };
  }

  /** Daemon model param: 'auto' / empty means "daemon default" → omit. */
  function modelParam(model?: string): { model?: string } {
    return model && model !== 'auto' ? { model } : {};
  }

  // -- list ---------------------------------------------------------------

  async function listMissions(): Promise<Mission[]> {
    const store = loadStore();
    return [...store.missions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // -- create (orchestrate/plan) -------------------------------------------

  async function createMission(input: CreateMissionInput): Promise<Mission> {
    const ts = nowIso();
    const mission: Mission = {
      id: crypto.randomUUID(),
      goal: input.goal,
      ...(input.model ? { model: input.model } : {}),
      workspaceRoot: input.workspaceRoot,
      createdAt: ts,
      updatedAt: ts,
      status: 'planned',
      logTail: [],
    };
    try {
      const res = (await rpc(
        'orchestrate/plan',
        { goal: input.goal, workspaceRoot: input.workspaceRoot, ...modelParam(input.model) },
        120_000,
      )) as { units?: unknown; totalBudget?: unknown };
      const units = Array.isArray(res?.units)
        ? (res.units.map(asPlannedUnit).filter((u): u is PlannedUnit => u !== null))
        : [];
      if (units.length === 0) throw new Error('daemon returned an empty plan');
      const totalBudget = typeof res.totalBudget === 'number' ? res.totalBudget : units.reduce((s, u) => s + u.budget, 0);
      mission.plan = { units, totalBudget };
      mission.status = 'planned';
      appendLog(mission, {
        ts: nowIso(),
        phase: 'planned',
        detail: `${units.length} units · est. ${totalBudget} model requests`,
      });
    } catch (e) {
      // Honest failure: persist the mission with the REAL error — no fake plan.
      mission.status = 'error';
      mission.error = errMessage(e);
      mission.plan = undefined;
      appendLog(mission, { ts: nowIso(), phase: 'failed', detail: mission.error });
    }
    const store = loadStore();
    store.missions.unshift(mission);
    saveStore(store);
    return mission;
  }

  // -- refresh (orchestrate/status — source of truth) ----------------------

  async function refreshMission(id: string): Promise<Mission> {
    const { mission } = findMission(id);
    if (!mission.runId) return mission;
    const res = (await rpc('orchestrate/status', { runId: mission.runId }, 30_000)) as Record<string, unknown>;
    // Re-load after the await: an event / stop may have landed meanwhile.
    const fresh = loadStore().missions.find((m) => m.id === id) ?? mission;
    if (Array.isArray(res.units)) {
      const units = res.units.map(asUnitRunState).filter((u): u is UnitRunState => u !== null);
      if (units.length > 0) fresh.units = units;
    }
    const daemonStatus = typeof res.status === 'string' ? res.status : '';
    const wasStopped = fresh.status === 'stopped';
    switch (daemonStatus) {
      case 'done':
        if (!wasStopped) fresh.status = 'done';
        break;
      case 'running':
        if (!wasStopped) fresh.status = 'running';
        break;
      case 'conflicted':
        if (!wasStopped) {
          fresh.status = 'failed';
          fresh.error = 'merge conflict — see unit states';
        }
        break;
      case 'failed':
      case 'cancelled':
      case 'interrupted':
        if (!wasStopped) fresh.status = 'failed';
        break;
      default:
        break;
    }
    return persistMission(fresh);
  }

  // -- start (orchestrate/run, long-running, NOT awaited) ------------------

  async function startMission(id: string): Promise<Mission> {
    const { store, mission } = findMission(id);
    const inFlight = store.missions.find(
      (m) => m.id !== id && (m.status === 'queued' || m.status === 'running'),
    );
    if (inFlight) throw new Error('another mission is already running');
    if (mission.status === 'queued' || mission.status === 'running') {
      throw new Error('another mission is already running');
    }
    mission.status = 'queued';
    delete mission.error;
    appendLog(mission, { ts: nowIso(), phase: 'queued', detail: 'run queued' });
    persistMission(mission);

    const runParams: Record<string, unknown> = {
      goal: mission.goal,
      workspaceRoot: mission.workspaceRoot,
      ...modelParam(mission.model),
      ...(mission.plan ? { plan: { units: mission.plan.units } } : {}),
    };

    void rpc('orchestrate/run', runParams, 30 * 60_000)
      .then(async (finalUnknown) => {
        const final = finalUnknown as {
          units?: { id: string; status: string; sha?: string }[];
          mergedSha?: string;
        };
        const current = loadStore().missions.find((m) => m.id === id);
        if (!current) return;
        if (current.status === 'stopped') return; // stop wins
        const finalUnits = Array.isArray(final?.units) ? final.units : [];
        if (finalUnits.length > 0) {
          current.units = finalUnits.map((fu) => {
            const planned = current.plan?.units.find((p) => p.id === fu.id);
            const existing = current.units?.find((u) => u.id === fu.id);
            return {
              id: fu.id,
              title: planned?.title ?? existing?.title ?? fu.id,
              status: fu.status === 'merged' ? 'done' : fu.status === 'cancelled' ? 'cancelled' : 'failed',
              ...(fu.sha ? { sha: fu.sha } : existing?.sha ? { sha: existing.sha } : {}),
              ...(existing?.worktreePath ? { worktreePath: existing.worktreePath } : {}),
              ...(existing?.model ? { model: existing.model } : {}),
            } as UnitRunState;
          });
          const allMerged = finalUnits.every((u) => u.status === 'merged');
          current.status = allMerged ? 'done' : 'failed';
          if (!allMerged && !current.error) {
            const bad = finalUnits.filter((u) => u.status !== 'merged');
            current.error = `unit(s) did not merge: ${bad.map((u) => `${u.id} (${u.status})`).join(', ')}`;
          }
          appendLog(current, {
            ts: nowIso(),
            phase: allMerged ? 'merged' : 'failed',
            detail: allMerged
              ? `run finished${final.mergedSha ? ` · merged ${final.mergedSha.slice(0, 8)}` : ''}`
              : (current.error ?? 'run finished with failures'),
          });
        } else {
          current.status = 'done';
          appendLog(current, { ts: nowIso(), phase: 'merged', detail: 'run finished' });
        }
        persistMission(current);
        // Refresh from the source of truth when a runId got bound by events.
        const after = loadStore().missions.find((m) => m.id === id);
        if (after?.runId && after.status !== 'stopped') {
          try {
            await refreshMission(id);
          } catch {
            // Status refresh is best-effort after a completed run; the
            // run result above already recorded the honest outcome.
          }
        }
      })
      .catch((e: unknown) => {
        const current = loadStore().missions.find((m) => m.id === id);
        if (!current) return;
        if (current.status === 'stopped') return; // stop wins over a cancel error
        current.status = 'error';
        current.error = errMessage(e);
        appendLog(current, { ts: nowIso(), phase: 'failed', detail: current.error });
        persistMission(current);
      });

    // Return the queued mission immediately — the run continues in background.
    return loadStore().missions.find((m) => m.id === id) ?? mission;
  }

  // -- stop (orchestrate/stop) ----------------------------------------------

  async function stopMission(id: string): Promise<Mission> {
    const { mission } = findMission(id);
    let stopError: string | undefined;
    if (mission.runId) {
      try {
        await rpc('orchestrate/stop', { runId: mission.runId }, 30_000);
      } catch (e) {
        stopError = errMessage(e);
      }
    }
    const fresh = loadStore().missions.find((m) => m.id === id) ?? mission;
    fresh.status = 'stopped';
    if (stopError) fresh.error = stopError;
    appendLog(fresh, { ts: nowIso(), phase: 'failed', detail: 'stopped by user' });
    return persistMission(fresh);
  }

  // -- orchestrate/event notifications ----------------------------------------
  //
  // Correlation rule: see the module header. First event with an unknown
  // runId binds to the single in-flight (queued/running, runId-less)
  // mission. Events are the live log + unit-status HINTS only;
  // orchestrate/status stays the source of truth.

  function handleOrchestrateEvent(params: unknown): void {
    if (!isRecord(params)) return;
    const { runId, unitId, phase, detail } = params as {
      runId?: unknown;
      unitId?: unknown;
      phase?: unknown;
      detail?: unknown;
    };
    if (typeof runId !== 'string' || runId.length === 0) return;
    if (typeof phase !== 'string' || !(ORCHESTRATE_PHASES as readonly string[]).includes(phase)) return;
    const unitIdStr = typeof unitId === 'string' ? unitId : undefined;
    const detailStr = typeof detail === 'string' ? detail : undefined;

    const store = loadStore();
    let mission = store.missions.find((m) => m.runId === runId);
    if (!mission) {
      // Bind: exactly one in-flight mission without a runId may claim it.
      const candidates = store.missions.filter(
        (m) => (m.status === 'queued' || m.status === 'running') && !m.runId,
      );
      if (candidates.length !== 1) return; // no honest target — drop
      mission = candidates[0];
      mission.runId = runId;
    }
    if (!mission) return;

    appendLog(mission, { ts: nowIso(), ...(unitIdStr ? { unitId: unitIdStr } : {}), phase, ...(detailStr ? { detail: detailStr } : {}) });

    // Unit-status hints + queued→running transition.
    if (phase === 'queued' || phase === 'started' || phase === 'verifying') {
      if (mission.status === 'queued') mission.status = 'running';
    }
    if (unitIdStr) {
      const hint: UnitRunStatus | undefined =
        phase === 'queued'
          ? 'queued'
          : phase === 'started'
            ? 'running'
            : phase === 'verifying'
              ? 'verifying'
              : phase === 'merged'
                ? 'done'
                : phase === 'failed' || phase === 'conflicted'
                  ? 'failed'
                  : undefined;
      if (hint) {
        if (!mission.units && mission.plan) {
          mission.units = mission.plan.units.map((u) => ({ id: u.id, title: u.title, status: 'queued' as UnitRunStatus }));
        }
        if (mission.units) {
          const unit = mission.units.find((u) => u.id === unitIdStr);
          if (unit) unit.status = hint;
        }
      }
    }

    mission.updatedAt = nowIso();
    saveStore(store);
  }

  // -- init --------------------------------------------------------------------

  function initMissionService(): void {
    if (initialized) return;
    initialized = true;
    addHandler('orchestrate/event', handleOrchestrateEvent);
  }

  return {
    listMissions,
    createMission,
    startMission,
    refreshMission,
    stopMission,
    handleOrchestrateEvent,
    initMissionService,
    missionsFilePath,
  };
}

// ---------------------------------------------------------------------------
// Default singleton (real daemon RPC + real state file)
// ---------------------------------------------------------------------------

const defaultService = createMissionService();

export function missionsFilePath(): string {
  return defaultService.missionsFilePath();
}

export function listMissions(): Promise<Mission[]> {
  return defaultService.listMissions();
}

export function createMission(input: CreateMissionInput): Promise<Mission> {
  return defaultService.createMission(input);
}

export function startMission(id: string): Promise<Mission> {
  return defaultService.startMission(id);
}

export function refreshMission(id: string): Promise<Mission> {
  return defaultService.refreshMission(id);
}

export function stopMission(id: string): Promise<Mission> {
  return defaultService.stopMission(id);
}

export function handleOrchestrateEvent(params: unknown): void {
  defaultService.handleOrchestrateEvent(params);
}

export function initMissionService(): void {
  defaultService.initMissionService();
}
