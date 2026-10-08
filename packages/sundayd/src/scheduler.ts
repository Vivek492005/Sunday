/**
 * @sunday/sundayd — Scheduled tasks (Group A, A5).
 *
 * Reads `~/.sunday/schedules/*.json` ([{name, cron, prompt, enabled}]),
 * fires due schedules on a 60s loop, executes the prompt through the agent
 * pipeline, and stores results under
 * `~/.sunday/schedules/runs/<name>/<timestamp>.json`. The IDE is notified
 * via `scheduler/event` notifications.
 *
 * Cron: minimal 5-field matcher (minute hour dom month dow) supporting
 * `*`, `*\/n`, ranges (`a-b`), lists (`a,b`), and steps on ranges
 * (`a-b/n`). No new dependencies.
 *
 * Safety: schedule names are strictly validated (no path traversal);
 * overlapping runs of the same schedule are skipped; all errors are
 * caught and recorded, never thrown into the loop.
 */

import { readdir, readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ScheduledTaskDef {
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
}

export interface ScheduleRunRecord {
  name: string;
  startedAt: string;
  finishedAt: string;
  status: 'completed' | 'failed' | 'skipped-overlap';
  result?: string;
  error?: string;
}

export interface SchedulerStatus {
  schedules: Array<ScheduledTaskDef & { lastRunAt?: string; lastStatus?: string }>;
  running: string[];
}

/** Name allowlist: prevents path traversal via the schedule name. */
export function isValidScheduleName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name);
}

// -- cron matcher ---------------------------------------------------------------

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

/** Parse one cron field into the set of matching values. Throws on invalid. */
export function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  const parts = field.split(',');
  if (parts.length === 0) throw new Error(`invalid cron field: "${field}"`);
  for (const part of parts) {
    if (!part) throw new Error(`invalid cron field: "${field}" (empty part)`);
    const [range, stepStr] = part.split('/');
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron step in "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      [lo, hi] = [min, max];
    } else if (range !== undefined && range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a === undefined) {
        throw new Error(`invalid cron range "${part}"`);
      }
      [lo, hi] = [a as number, b as number];
    } else {
      const v = Number(range);
      if (!Number.isInteger(v)) throw new Error(`invalid cron value "${part}"`);
      [lo, hi] = [v, v];
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron value out of range "${part}" (expected ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) throw new Error(`invalid cron field: "${field}"`);
  return values;
}

/** Validate a 5-field cron expression. Throws on invalid. */
export function validateCron(cron: string): void {
  if (typeof cron !== 'string') throw new Error('cron must be a string');
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields, got ${fields.length}`);
  fields.forEach((f, i) => parseCronField(f, FIELD_RANGES[i]![0], FIELD_RANGES[i]![1]));
}

/** True when the cron expression matches the given date (local time). */
export function cronMatches(cron: string, date: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const parts = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  return fields.every((f, i) => {
    try {
      return parseCronField(f, FIELD_RANGES[i]![0], FIELD_RANGES[i]![1]).has(parts[i]!);
    } catch {
      return false;
    }
  });
}

// -- scheduler -------------------------------------------------------------------

export interface TaskSchedulerDeps {
  /** Dir holding *.json schedule defs (and runs/). */
  schedulesDir: string;
  /** Execute one prompt; resolves with result text. */
  execute: (prompt: string) => Promise<string>;
  /** Notify the IDE (scheduler/event). */
  notify: (event: Record<string, unknown>) => void;
  checkIntervalMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Set<string>();
  private readonly lastFiredMinute = new Map<string, string>();
  private checking = false;

  constructor(private readonly deps: TaskSchedulerDeps) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.log(`tick failed: ${(e as Error).message}`));
    }, this.deps.checkIntervalMs ?? 60_000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Names of currently running schedules (tests/introspection). */
  runningNames(): string[] {
    return [...this.running];
  }

  private log(msg: string): void {
    this.deps.log?.(`[scheduler] ${msg}`);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Load + validate all schedule defs. Invalid files are skipped (logged). */
  async loadSchedules(): Promise<ScheduledTaskDef[]> {
    const out: ScheduledTaskDef[] = [];
    let files: string[];
    try {
      files = await readdir(this.deps.schedulesDir);
    } catch {
      return [];
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const full = join(this.deps.schedulesDir, file);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      try {
        const raw = JSON.parse(await readFile(full, 'utf8')) as Record<string, unknown>;
        const def = this.validateDef(raw);
        if (def) out.push(def);
      } catch (e) {
        this.log(`skipping invalid schedule file ${file}: ${(e as Error).message}`);
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private validateDef(raw: Record<string, unknown>): ScheduledTaskDef | undefined {
    if (!isValidScheduleName(raw.name)) {
      throw new Error(`invalid schedule name: ${String(raw.name)}`);
    }
    const cron = raw.cron;
    if (typeof cron !== 'string') throw new Error('cron is required');
    validateCron(cron);
    const prompt = raw.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
    if (prompt.length > 8000) throw new Error('prompt exceeds 8000 characters');
    return {
      name: raw.name as string,
      cron: cron.trim(),
      prompt: prompt.trim(),
      enabled: raw.enabled !== false,
    };
  }

  /** One check cycle: fire due schedules. Public for tests. */
  async tick(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = this.now();
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      const schedules = await this.loadSchedules();
      for (const s of schedules) {
        if (!s.enabled) continue;
        if (!cronMatches(s.cron, now)) continue;
        if (this.lastFiredMinute.get(s.name) === minuteKey) continue; // already fired this minute
        this.lastFiredMinute.set(s.name, minuteKey);
        // Fire-and-forget per schedule; overlap is guarded inside runSchedule.
        void this.runSchedule(s).catch((e) => this.log(`schedule ${s.name} failed: ${(e as Error).message}`));
      }
    } finally {
      this.checking = false;
    }
  }

  /** Execute one schedule now (also used by scheduler/run-now). */
  async runSchedule(def: ScheduledTaskDef): Promise<ScheduleRunRecord> {
    if (this.running.has(def.name)) {
      const rec: ScheduleRunRecord = {
        name: def.name,
        startedAt: this.now().toISOString(),
        finishedAt: this.now().toISOString(),
        status: 'skipped-overlap',
        error: 'previous run still in progress',
      };
      await this.storeRun(rec);
      this.notify({ type: 'scheduler/run-skipped', name: def.name, reason: 'overlap' });
      return rec;
    }
    this.running.add(def.name);
    this.notify({ type: 'scheduler/run-started', name: def.name });
    const startedAt = this.now().toISOString();
    let rec: ScheduleRunRecord;
    try {
      const result = await this.deps.execute(def.prompt);
      rec = {
        name: def.name,
        startedAt,
        finishedAt: this.now().toISOString(),
        status: 'completed',
        result: result.slice(0, 200_000),
      };
    } catch (e) {
      rec = {
        name: def.name,
        startedAt,
        finishedAt: this.now().toISOString(),
        status: 'failed',
        error: (e as Error).message.slice(0, 4000),
      };
    } finally {
      this.running.delete(def.name);
    }
    await this.storeRun(rec);
    this.notify({
      type: rec.status === 'completed' ? 'scheduler/run-completed' : 'scheduler/run-failed',
      name: def.name,
      status: rec.status,
    });
    return rec;
  }

  private notify(event: Record<string, unknown>): void {
    try {
      this.deps.notify({ ...event, ts: this.now().toISOString() });
    } catch (e) {
      this.log(`notify failed: ${(e as Error).message}`);
    }
  }

  private runsDir(name: string): string {
    return join(this.deps.schedulesDir, 'runs', name);
  }

  private async storeRun(rec: ScheduleRunRecord): Promise<void> {
    try {
      const dir = this.runsDir(rec.name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const stamp = rec.startedAt.replace(/[:.]/g, '-');
      const file = join(dir, `${stamp}.json`);
      await writeFile(file, JSON.stringify(rec, null, 2), { mode: 0o600 });
      await chmod(file, 0o600);
    } catch (e) {
      this.log(`failed to store run for ${rec.name}: ${(e as Error).message}`);
    }
  }

  /** Last run record for a schedule (for status). */
  async lastRun(name: string): Promise<ScheduleRunRecord | undefined> {
    try {
      const files = await readdir(this.runsDir(name));
      const latest = files.filter((f) => f.endsWith('.json')).sort().pop();
      if (!latest) return undefined;
      return JSON.parse(await readFile(join(this.runsDir(name), latest), 'utf8')) as ScheduleRunRecord;
    } catch {
      return undefined;
    }
  }

  /** Full status for scheduler/status (+ Mission Control). */
  async status(): Promise<SchedulerStatus> {
    const schedules = await this.loadSchedules();
    const withRuns = await Promise.all(
      schedules.map(async (s) => {
        const last = await this.lastRun(s.name);
        return {
          ...s,
          ...(last ? { lastRunAt: last.finishedAt, lastStatus: last.status } : {}),
        };
      }),
    );
    return { schedules: withRuns, running: this.runningNames() };
  }

  // -- CRUD (used by scheduler/* RPC) ---------------------------------------------

  private fileFor(name: string): string {
    return join(this.deps.schedulesDir, `${name}.json`);
  }

  async create(def: { name: string; cron: string; prompt: string }): Promise<ScheduledTaskDef> {
    const full = this.validateDef({ ...def, enabled: true });
    if (!full) throw new Error('invalid schedule');
    try {
      await stat(this.fileFor(full.name));
      throw new Error(`schedule "${full.name}" already exists`);
    } catch (e) {
      if ((e as Error).message.includes('already exists')) throw e;
      // not existing — good
    }
    await mkdir(this.deps.schedulesDir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(full.name);
    await writeFile(file, JSON.stringify(full, null, 2), { mode: 0o600 });
    await chmod(file, 0o600);
    return full;
  }

  async update(
    name: string,
    patch: { enabled?: boolean; cron?: string; prompt?: string },
  ): Promise<ScheduledTaskDef> {
    if (!isValidScheduleName(name)) throw new Error(`invalid schedule name: ${name}`);
    const file = this.fileFor(name);
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`unknown schedule: ${name}`);
    }
    const merged = { ...raw, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    const full = this.validateDef(merged);
    if (!full) throw new Error('invalid schedule');
    await writeFile(file, JSON.stringify(full, null, 2), { mode: 0o600 });
    await chmod(file, 0o600);
    return full;
  }

  async remove(name: string): Promise<void> {
    if (!isValidScheduleName(name)) throw new Error(`invalid schedule name: ${name}`);
    const { unlink } = await import('node:fs/promises');
    try {
      await unlink(this.fileFor(name));
    } catch {
      throw new Error(`unknown schedule: ${name}`);
    }
  }
}

/**
 * Register scheduler/* RPC methods (manager.ts pattern). The scheduler
 * instance is created here so cli.ts stays a one-liner; the loop starts
 * on first use.
 */
export interface RegisterSchedulerMethodsDeps {
  addMethod: (name: string, handler: (params: unknown) => Promise<unknown>) => void;
  schedulesDir: string;
  execute: (prompt: string) => Promise<string>;
  notify: (event: Record<string, unknown>) => void;
  log?: (msg: string) => void;
}

export function registerSchedulerMethods(deps: RegisterSchedulerMethodsDeps): TaskScheduler {
  const scheduler = new TaskScheduler({
    schedulesDir: deps.schedulesDir,
    execute: deps.execute,
    notify: deps.notify,
    log: deps.log,
  });
  scheduler.start();

  const needName = (params: unknown): string => {
    const p = params as Record<string, unknown> | undefined;
    const name = p?.name;
    if (!isValidScheduleName(name)) throw new Error('scheduler: valid "name" is required');
    return name;
  };

  deps.addMethod('scheduler/list', async () => {
    const { schedules } = await scheduler.status();
    return { schedules };
  });
  deps.addMethod('scheduler/create', async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const created = await scheduler.create({
      name: p.name as string,
      cron: p.cron as string,
      prompt: p.prompt as string,
    });
    return { schedule: created };
  });
  deps.addMethod('scheduler/update', async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const updated = await scheduler.update(p.name as string, {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined,
      cron: typeof p.cron === 'string' ? p.cron : undefined,
      prompt: typeof p.prompt === 'string' ? p.prompt : undefined,
    });
    return { schedule: updated };
  });
  deps.addMethod('scheduler/delete', async (params) => {
    await scheduler.remove(needName(params));
    return { deleted: true as const };
  });
  deps.addMethod('scheduler/status', async () => scheduler.status());
  deps.addMethod('scheduler/run-now', async (params) => {
    const name = needName(params);
    const schedules = await scheduler.loadSchedules();
    const def = schedules.find((s) => s.name === name);
    if (!def) throw new Error(`unknown schedule: ${name}`);
    const rec = await scheduler.runSchedule(def);
    return { run: rec };
  });
  return scheduler;
}
