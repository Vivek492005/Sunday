/**
 * @sunday/orchestrator — Parallel Agents: durable run state.
 *
 * The shared contract's run/unit/conflict types live in @sunday/protocol
 * (orchestrate.ts) and are re-exported through schemas.ts; this module adds
 * the file-backed store plus the module-level registries the runner and the
 * daemon's `orchestrate/stop|status` handlers use.
 *
 * Persistence convention follows packages/sundayd/src/sessions.ts: one JSON
 * file per run, atomic write (temp file + rename), corrupt files skipped on
 * read so one bad file can't wedge reconciliation.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ConflictResolution,
  MergeConflict,
  OrchestrationRunState,
  RunStatus,
  UnitRunState,
} from './schemas.js';

export type { ConflictResolution, MergeConflict, OrchestrationRunState, RunStatus, UnitRunState };

/** Run statuses that need no further action (reconcile leaves them alone). */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'done',
  'failed',
  'cancelled',
  'interrupted',
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** Same convention as sessions.ts `defaultSessionsDir`. */
export function defaultOrchestrationsDir(): string {
  return path.join(os.homedir(), '.sunday', 'orchestrations');
}

function runFileName(runId: string): string {
  return `${runId}.json`;
}

function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId);
}

/**
 * One JSON file per orchestration run under
 * `~/.sunday/orchestrations/<runId>.json`. Constructed by sundayd (Worker 2)
 * and passed to the runner via RunOrchestrationOptions.store; tests pass a
 * temp dir. Never point this at the real home dir in tests.
 */
export class FileOrchestrationStateStore {
  constructor(private dir: string = defaultOrchestrationsDir()) {}

  get directory(): string {
    return this.dir;
  }

  /** Create the dir (0700); sweep temp files orphaned by a crashed persist;
   *  purge runs older than the retention window (P1-2). */
  async init(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const files = await fsp.readdir(this.dir).catch(() => [] as string[]);
    for (const f of files) {
      if (f.endsWith('.tmp')) {
        await fsp.unlink(path.join(this.dir, f)).catch(() => undefined);
      }
    }
    await this.sweepExpired();
  }

  /** Delete run files older than SUNDAY_RETENTION_DAYS (default 30).
   *  Returns the number of runs purged. */
  async sweepExpired(now: number = Date.now()): Promise<number> {
    const raw = process.env.SUNDAY_RETENTION_DAYS?.trim();
    const days = raw === undefined || raw === '' ? 30 : Number.parseInt(raw, 10);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    let purged = 0;
    for (const f of await fsp.readdir(this.dir).catch(() => [] as string[])) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(this.dir, f);
      try {
        const stat = await fsp.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fsp.unlink(full);
          purged++;
        }
      } catch {
        // ignore races
      }
    }
    return purged;
  }

  /** Atomic persist (temp file + rename) on every state transition. The tmp
   *  name is unique per write (not just per pid) because parallel units
   *  persist the same run file concurrently. Files are owner-only (0600):
   *  run state may contain goal text and error strings with secrets. */
  async save(state: OrchestrationRunState): Promise<void> {
    if (!isSafeRunId(state.runId)) throw new Error(`unsafe runId: ${state.runId}`);
    const full = path.join(this.dir, runFileName(state.runId));
    const tmp = `${full}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fsp.rename(tmp, full);
  }

  async load(runId: string): Promise<OrchestrationRunState | undefined> {
    if (!isSafeRunId(runId)) return undefined;
    try {
      const raw = JSON.parse(
        await fsp.readFile(path.join(this.dir, runFileName(runId)), 'utf8'),
      ) as OrchestrationRunState;
      if (typeof raw?.runId !== 'string' || !Array.isArray(raw.units)) return undefined;
      return raw;
    } catch {
      return undefined;
    }
  }

  /** Every parseable run file; corrupt files are skipped (never throw). */
  async list(): Promise<OrchestrationRunState[]> {
    const files = await fsp.readdir(this.dir).catch(() => [] as string[]);
    const out: OrchestrationRunState[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(
          await fsp.readFile(path.join(this.dir, f), 'utf8'),
        ) as OrchestrationRunState;
        if (typeof raw?.runId === 'string' && Array.isArray(raw.units)) out.push(raw);
      } catch {
        // Skip corrupt files — one bad file can't wedge the listing.
      }
    }
    return out;
  }

  async remove(runId: string): Promise<void> {
    if (!isSafeRunId(runId)) return;
    await fsp.unlink(path.join(this.dir, runFileName(runId))).catch(() => undefined);
  }
}

/* ---- Module-level registries (in-process; Worker 2's handlers read these) ---- */

/** Live states for runs touched by this process (persisted via the store). */
const liveStates = new Map<string, OrchestrationRunState>();

/** Lazily-created module default store (real ~/.sunday/orchestrations). */
let defaultStoreInstance: FileOrchestrationStateStore | undefined;
function moduleDefaultStore(): FileOrchestrationStateStore {
  if (!defaultStoreInstance) defaultStoreInstance = new FileOrchestrationStateStore();
  return defaultStoreInstance;
}

/** Track (or refresh) a run's live state. Called by the runner on every transition. */
export function trackRunState(state: OrchestrationRunState): void {
  liveStates.set(state.runId, state);
}

/** Drop a run from the live registry (keeps the persisted file). */
export function untrackRunState(runId: string): void {
  liveStates.delete(runId);
}

/**
 * Latest known state for a run: live registry first, then the persisted
 * file under the default dir. Synchronous — safe for status handlers.
 */
export function getOrchestrationRunState(runId: string): OrchestrationRunState | undefined {
  const live = liveStates.get(runId);
  if (live) return live;
  if (!isSafeRunId(runId)) return undefined;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(defaultOrchestrationsDir(), runFileName(runId)), 'utf8'),
    ) as OrchestrationRunState;
    if (typeof raw?.runId === 'string' && Array.isArray(raw.units)) {
      liveStates.set(raw.runId, raw);
      return raw;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** All known runs: persisted files merged over (and overridden by) live state. */
export function listOrchestrationRuns(): OrchestrationRunState[] {
  const out = new Map<string, OrchestrationRunState>();
  try {
    for (const f of fs.readdirSync(defaultOrchestrationsDir())) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(defaultOrchestrationsDir(), f), 'utf8'),
        ) as OrchestrationRunState;
        if (typeof raw?.runId === 'string' && Array.isArray(raw.units)) out.set(raw.runId, raw);
      } catch {
        // skip corrupt files
      }
    }
  } catch {
    // dir may not exist yet — no persisted runs
  }
  for (const [id, s] of liveStates) out.set(id, s);
  return [...out.values()];
}

/**
 * Daemon-start reconciliation (called by sundayd, Worker 2): runs left in a
 * non-terminal state by a crash/shutdown become 'interrupted'. 'conflicted'
 * runs are left alone — their worktrees are intact on disk and still await
 * resolveRunConflicts. Best-effort worktree cleanup runs through the
 * caller-supplied callback (the orchestrator can't dispatch without a host).
 */
export async function reconcileOrchestrationRuns(
  store: FileOrchestrationStateStore,
  cleanup?: (unit: UnitRunState) => Promise<void>,
): Promise<void> {
  await store.init();
  for (const state of await store.list()) {
    if (state.status !== 'running') continue;
    state.status = 'interrupted';
    state.updatedAt = new Date().toISOString();
    if (cleanup) {
      for (const unit of state.units) {
        if (!unit.worktreePath) continue;
        try {
          await cleanup(unit);
        } catch {
          // best-effort: a failed cleanup must not block reconciliation
        }
      }
    }
    try {
      await store.save(state);
    } catch {
      // best-effort
    }
    trackRunState(state);
  }
}

/** The module default store (used when RunOrchestrationOptions.store is absent). */
export function getDefaultOrchestrationStore(): FileOrchestrationStateStore {
  return moduleDefaultStore();
}
