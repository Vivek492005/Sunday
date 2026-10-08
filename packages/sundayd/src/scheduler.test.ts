// Tests for the A5 task scheduler: cron matcher edge cases (*/15,
// ranges, lists, steps), schedule loading/validation, tick firing,
// disabled schedules skipped, overlapping runs prevented, run-now, and
// CRUD. No timers (tick driven directly), no daemon.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import {
  TaskScheduler,
  cronMatches,
  isValidScheduleName,
  parseCronField,
  registerSchedulerMethods,
  validateCron,
} from './scheduler.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sunday-scheduler-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSchedule(name: string, def: Record<string, unknown>): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(def));
}

function makeScheduler(opts: {
  now?: () => Date;
  execute?: (prompt: string) => Promise<string>;
} = {}) {
  const executed: string[] = [];
  const notifications: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const scheduler = new TaskScheduler({
    schedulesDir: dir,
    execute: opts.execute ?? (async (p) => { executed.push(p); return `done: ${p}`; }),
    notify: (e) => notifications.push(e),
    now: opts.now,
    log: (m) => logs.push(m),
  });
  return { scheduler, executed, notifications, logs };
}

describe('parseCronField', () => {
  it('parses *, */n, ranges, lists, and steps', () => {
    expect(parseCronField('*', 0, 59).size).toBe(60);
    expect([...parseCronField('*/15', 0, 59)].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...parseCronField('5', 0, 59)]).toEqual([5]);
    expect([...parseCronField('1,2,3', 0, 59)]).toEqual([1, 2, 3]);
    expect([...parseCronField('9-11', 0, 23)]).toEqual([9, 10, 11]);
    expect([...parseCronField('0-30/10', 0, 59)]).toEqual([0, 10, 20, 30]);
    expect([...parseCronField('1,*/20', 0, 59)].sort((a, b) => a - b)).toEqual([0, 1, 20, 40]);
  });

  it('rejects invalid fields', () => {
    expect(() => parseCronField('60', 0, 59)).toThrow(/out of range/);
    expect(() => parseCronField('5-2', 0, 59)).toThrow(/out of range/);
    expect(() => parseCronField('*/0', 0, 59)).toThrow(/step/);
    expect(() => parseCronField('abc', 0, 59)).toThrow(/invalid/);
    expect(() => parseCronField('', 0, 59)).toThrow();
  });
});

describe('validateCron / cronMatches', () => {
  it('validates 5-field expressions', () => {
    expect(() => validateCron('* * * * *')).not.toThrow();
    expect(() => validateCron('*/15 9-17 * * 1-5')).not.toThrow();
    expect(() => validateCron('* * * *')).toThrow(/5 fields/);
    expect(() => validateCron('* * * * * *')).toThrow(/5 fields/);
    expect(() => validateCron('61 * * * *')).toThrow(/out of range/);
  });

  it('matches the right minutes', () => {
    // 2026-10-08 10:30 local, a Thursday.
    const d = new Date(2026, 9, 8, 10, 30);
    expect(d.getDay()).toBe(4);
    expect(cronMatches('* * * * *', d)).toBe(true);
    expect(cronMatches('30 * * * *', d)).toBe(true);
    expect(cronMatches('31 * * * *', d)).toBe(false);
    expect(cronMatches('*/15 * * * *', d)).toBe(true);
    expect(cronMatches('*/20 * * * *', d)).toBe(false);
    expect(cronMatches('* 10 * * *', d)).toBe(true);
    expect(cronMatches('* 9-11 * * *', d)).toBe(true);
    expect(cronMatches('* * * * 4', d)).toBe(true);
    expect(cronMatches('* * * * 5', d)).toBe(false);
    expect(cronMatches('30 10 8 10 4', d)).toBe(true);
    expect(cronMatches('30 10 8 10 *', d)).toBe(true);
  });

  it('returns false for malformed crons instead of throwing', () => {
    expect(cronMatches('nope', new Date())).toBe(false);
  });
});

describe('isValidScheduleName', () => {
  it('allows safe names and rejects traversal', () => {
    expect(isValidScheduleName('nightly-backup_2')).toBe(true);
    expect(isValidScheduleName('../evil')).toBe(false);
    expect(isValidScheduleName('a/b')).toBe(false);
    expect(isValidScheduleName('')).toBe(false);
    expect(isValidScheduleName('.hidden')).toBe(false);
  });
});

describe('TaskScheduler', () => {
  it('fires due schedules and stores run records', async () => {
    writeSchedule('every-minute', { name: 'every-minute', cron: '* * * * *', prompt: 'do it', enabled: true });
    const now = new Date(2026, 9, 8, 10, 30);
    const { scheduler, executed, notifications } = makeScheduler({ now: () => now });
    await scheduler.tick();
    // let the fire-and-forget run finish
    await new Promise((r) => setTimeout(r, 50));
    expect(executed).toEqual(['do it']);
    const runs = await readdir(join(dir, 'runs', 'every-minute'));
    expect(runs).toHaveLength(1);
    expect(notifications.map((n) => n.type)).toContain('scheduler/run-completed');
    // Same minute again -> no double fire.
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(executed).toHaveLength(1);
  });

  it('skips disabled schedules and non-matching crons', async () => {
    writeSchedule('off', { name: 'off', cron: '* * * * *', prompt: 'x', enabled: false });
    writeSchedule('later', { name: 'later', cron: '0 0 * * *', prompt: 'y', enabled: true });
    const { scheduler, executed } = makeScheduler({ now: () => new Date(2026, 9, 8, 10, 30) });
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(executed).toEqual([]);
  });

  it('skips invalid schedule files but loads the valid ones', async () => {
    writeSchedule('good', { name: 'good', cron: '* * * * *', prompt: 'g', enabled: true });
    writeSchedule('bad-cron', { name: 'bad-cron', cron: 'nope', prompt: 'g', enabled: true });
    writeSchedule('bad-name', { name: '../evil', cron: '* * * * *', prompt: 'g' });
    writeFileSync(join(dir, 'not-json.json'), '{oops');
    const { scheduler, logs } = makeScheduler();
    const loaded = await scheduler.loadSchedules();
    expect(loaded.map((s) => s.name)).toEqual(['good']);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('prevents overlapping runs of the same schedule', async () => {
    writeSchedule('slow', { name: 'slow', cron: '* * * * *', prompt: 's', enabled: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { scheduler } = makeScheduler({
      now: () => new Date(2026, 9, 8, 10, 30),
      execute: async () => { await gate; return 'slow done'; },
    });
    const schedules = await scheduler.loadSchedules();
    const p1 = scheduler.runSchedule(schedules[0]!);
    // While p1 holds the lock, a second run is skipped, not queued.
    await new Promise((r) => setTimeout(r, 20));
    const rec2 = await scheduler.runSchedule(schedules[0]!);
    expect(rec2.status).toBe('skipped-overlap');
    release();
    const rec1 = await p1;
    expect(rec1.status).toBe('completed');
    expect(scheduler.runningNames()).toEqual([]);
  });

  it('records failures and continues', async () => {
    writeSchedule('bad', { name: 'bad', cron: '* * * * *', prompt: 'b', enabled: true });
    const { scheduler, notifications } = makeScheduler({
      now: () => new Date(2026, 9, 8, 10, 30),
      execute: async () => { throw new Error('model down'); },
    });
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications.map((n) => n.type)).toContain('scheduler/run-failed');
    const status = await scheduler.status();
    expect(status.schedules[0]!.lastStatus).toBe('failed');
  });

  it('status reports schedules, last runs, and running sets', async () => {
    writeSchedule('a', { name: 'a', cron: '* * * * *', prompt: 'x', enabled: true });
    const { scheduler } = makeScheduler();
    const st = await scheduler.status();
    expect(st.schedules).toHaveLength(1);
    expect(st.schedules[0]).toMatchObject({ name: 'a', cron: '* * * * *', enabled: true });
    expect(st.running).toEqual([]);
  });

  it('CRUD: create / update / delete with validation', async () => {
    const { scheduler } = makeScheduler();
    const created = await scheduler.create({ name: 'nightly', cron: '0 2 * * *', prompt: 'backup' });
    expect(created.enabled).toBe(true);
    await expect(scheduler.create({ name: 'nightly', cron: '* * * * *', prompt: 'x' })).rejects.toThrow(/already exists/);
    await expect(scheduler.create({ name: '../evil', cron: '* * * * *', prompt: 'x' })).rejects.toThrow(/invalid schedule name/);
    await expect(scheduler.create({ name: 'bad', cron: 'nope', prompt: 'x' })).rejects.toThrow();
    const updated = await scheduler.update('nightly', { enabled: false, cron: '30 2 * * *' });
    expect(updated.enabled).toBe(false);
    expect(updated.cron).toBe('30 2 * * *');
    await expect(scheduler.update('missing', { enabled: true })).rejects.toThrow(/unknown schedule/);
    await scheduler.remove('nightly');
    expect(await scheduler.loadSchedules()).toEqual([]);
    await expect(scheduler.remove('nightly')).rejects.toThrow(/unknown schedule/);
  });
});

describe('registerSchedulerMethods', () => {
  it('registers the six scheduler/* methods and they work end-to-end', async () => {
    const methods = new Map<string, (params: unknown) => Promise<unknown>>();
    const notifications: Array<Record<string, unknown>> = [];
    const scheduler = registerSchedulerMethods({
      addMethod: (name, handler) => methods.set(name, handler),
      schedulesDir: dir,
      execute: async (p) => `ran: ${p}`,
      notify: (e) => notifications.push(e),
    });
    try {
      expect([...methods.keys()].sort()).toEqual([
        'scheduler/create', 'scheduler/delete', 'scheduler/list',
        'scheduler/run-now', 'scheduler/status', 'scheduler/update',
      ]);
      const created = (await methods.get('scheduler/create')!({
        name: 'job1', cron: '* * * * *', prompt: 'hello',
      })) as { schedule: { name: string } };
      expect(created.schedule.name).toBe('job1');
      const listed = (await methods.get('scheduler/list')!({})) as { schedules: Array<{ name: string }> };
      expect(listed.schedules.map((s) => s.name)).toEqual(['job1']);
      const run = (await methods.get('scheduler/run-now')!({ name: 'job1' })) as {
        run: { status: string; result: string };
      };
      expect(run.run.status).toBe('completed');
      expect(run.run.result).toBe('ran: hello');
      await methods.get('scheduler/update')!({ name: 'job1', enabled: false });
      const status = (await methods.get('scheduler/status')!({})) as {
        schedules: Array<{ enabled: boolean }>;
      };
      expect(status.schedules[0]!.enabled).toBe(false);
      await methods.get('scheduler/delete')!({ name: 'job1' });
      const listed2 = (await methods.get('scheduler/list')!({})) as { schedules: unknown[] };
      expect(listed2.schedules).toEqual([]);
      await expect(methods.get('scheduler/run-now')!({ name: 'nope' })).rejects.toThrow(/unknown schedule/);
      await expect(methods.get('scheduler/delete')!({ name: '../x' })).rejects.toThrow(/valid "name"/);
    } finally {
      scheduler.stop();
    }
  });
});
