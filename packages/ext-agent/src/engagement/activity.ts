// sunday-agent — engagement: local activity tracking for coding streaks.
//
// Records MEANINGFUL coding actions only (never bare app opens):
//   - git commits, 30+ min active editing, merged PRs, completed AI tasks, test runs
//
// Storage: ~/.sunday/engagement/activity.json (0600). Pure Node — no vscode
// dependency, so it is fully unit-testable. Old data is pruned
// opportunistically (400 days retained).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { markAgentUsed } from './mode.js';

/** Minutes of active editing that qualify a day as a "streak day". */
export const STREAK_DAY_EDIT_MINUTES = 30;
/** Days of activity history retained. */
export const ACTIVITY_RETAIN_DAYS = 400;
/** Edits within this gap (ms) count as continuous active editing. */
export const EDIT_SESSION_GAP_MS = 5 * 60_000;

export interface DayActivity {
  commits: number;
  editMinutes: number;
  prsMerged: number;
  aiTasks: number;
  testsRun: number;
}

export function zeroDayActivity(): DayActivity {
  return { commits: 0, editMinutes: 0, prsMerged: 0, aiTasks: 0, testsRun: 0 };
}

/** Local-timezone day key: `YYYY-MM-DD`. Streaks follow the user's clock. */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Shift a day key by N days (negative = past). */
export function addDaysKey(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + delta);
  return localDayKey(dt);
}

/** Whole days from a to b (b - a). */
export function dayKeyDiff(a: string, b: string): number {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  const da = new Date(pa[0] ?? 1970, (pa[1] ?? 1) - 1, pa[2] ?? 1);
  const db = new Date(pb[0] ?? 1970, (pb[1] ?? 1) - 1, pb[2] ?? 1);
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/**
 * Does this day count toward the streak? Commit OR 30+ min editing OR a
 * merged PR OR a completed AI task. Test runs are tracked but do not alone
 * qualify — the bar is shipped work.
 */
export function isStreakDay(a: DayActivity): boolean {
  return (
    a.commits > 0 ||
    a.editMinutes >= STREAK_DAY_EDIT_MINUTES ||
    a.prsMerged > 0 ||
    a.aiTasks > 0
  );
}

interface ActivityFile {
  version: 1;
  days: Record<string, DayActivity>;
}

export class ActivityStore {
  constructor(
    private readonly baseDir?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private dir(): string {
    return this.baseDir ?? path.join(os.homedir(), '.sunday', 'engagement');
  }

  private file(): string {
    return path.join(this.dir(), 'activity.json');
  }

  /** Load all retained days. Never throws — returns {} on any problem. */
  load(): Record<string, DayActivity> {
    try {
      const raw = fs.readFileSync(this.file(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ActivityFile>;
      if (!parsed || typeof parsed.days !== 'object' || parsed.days === null) return {};
      return parsed.days;
    } catch {
      return {};
    }
  }

  private save(days: Record<string, DayActivity>): void {
    try {
      fs.mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      const tmp = `${this.file()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, days }), 'utf8');
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file());
    } catch {
      // Activity tracking must never break the IDE.
    }
  }

  /** Mutate today's bucket, prune old days, persist. Never throws. */
  record(mut: (d: DayActivity) => void): DayActivity {
    const days = this.load();
    const key = localDayKey(this.now());
    const d = days[key] ?? zeroDayActivity();
    mut(d);
    days[key] = d;
    this.prune(days);
    this.save(days);
    return d;
  }

  private prune(days: Record<string, DayActivity>): void {
    const cutoffKey = addDaysKey(localDayKey(this.now()), -ACTIVITY_RETAIN_DAYS);
    for (const k of Object.keys(days)) {
      if (k < cutoffKey) delete days[k];
    }
  }

  getDay(dayKey: string): DayActivity {
    return this.load()[dayKey] ?? zeroDayActivity();
  }

  recordCommit(): void {
    this.record((d) => {
      d.commits += 1;
    });
  }

  recordEditMinutes(minutes: number): void {
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.record((d) => {
      d.editMinutes += minutes;
    });
  }

  recordPRMerged(): void {
    this.record((d) => {
      d.prsMerged += 1;
    });
  }

  recordAITaskCompleted(): void {
    // An AI task completion also flips the session into ACTIVE engagement
    // mode (auto-detect): the user is now using agent features.
    markAgentUsed();
    this.record((d) => {
      d.aiTasks += 1;
    });
  }

  recordTestRun(): void {
    this.record((d) => {
      d.testsRun += 1;
    });
  }
}

/**
 * Accumulates active editing minutes from document-change events.
 * Edits separated by more than EDIT_SESSION_GAP_MS start a new session
 * (idle time is not counted). Feed `noteEdit()` from
 * `vscode.workspace.onDidChangeTextDocument`.
 */
export class EditActivityTracker {
  private lastEditMs = 0;

  constructor(
    private readonly store: ActivityStore,
    private readonly nowMs: () => number = Date.now,
  ) {}

  noteEdit(atMs: number = this.nowMs()): void {
    if (this.lastEditMs > 0 && atMs > this.lastEditMs) {
      const gapMin = (atMs - this.lastEditMs) / 60_000;
      if (gapMin <= EDIT_SESSION_GAP_MS / 60_000) {
        this.store.recordEditMinutes(gapMin);
      }
    }
    this.lastEditMs = atMs;
  }

  /** Call when the window loses focus / IDE suspends so idle time isn't counted. */
  reset(): void {
    this.lastEditMs = 0;
  }
}
