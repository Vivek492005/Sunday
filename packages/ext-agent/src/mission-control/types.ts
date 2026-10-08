// Mission Control — aggregation model (Group A, A4).
//
// A dashboard card for every piece of running work: orchestrator runs,
// browser sessions, cloud tasks (A1) and scheduled tasks (A5). Each
// source is a small adapter implementing WorkSource; aggregateWork()
// merges them. Pure logic lives here so it is unit-testable without a
// webview or a daemon.

/** A single card on the dashboard. */
export interface WorkItem {
  /** Stable id within its source. */
  id: string;
  /** Which source produced it. */
  kind: 'orchestration' | 'browser' | 'cloud-task' | 'schedule';
  /** Human-readable name/title. */
  name: string;
  /** Raw status from the source (running, queued, completed, failed, …). */
  status: string;
  /** Epoch ms the work started (or was created). */
  startedAt: number;
  /** Tail of recent log lines, most recent last. */
  lastLog: string[];
  /** Whether Stop applies to this item right now. */
  stoppable: boolean;
  /** Whether Restart applies to this item right now. */
  restartable: boolean;
}

export interface WorkSource {
  kind: WorkItem['kind'];
  /** Section heading in the dashboard. */
  label: string;
  /** Note shown when the section is empty (e.g. "gateway unreachable"). */
  emptyNote?: string;
  list(): Promise<WorkItem[]>;
  stop(item: WorkItem): Promise<void>;
  restart(item: WorkItem): Promise<void>;
}

/** Aggregate all sources; a failing source yields an empty section, never a crash. */
export async function aggregateWork(sources: WorkSource[]): Promise<{ items: WorkItem[]; errors: string[] }> {
  const items: WorkItem[] = [];
  const errors: string[] = [];
  for (const src of sources) {
    try {
      items.push(...(await src.list()));
    } catch (err) {
      errors.push(`${src.label}: ${(err as Error).message}`);
    }
  }
  return { items, errors };
}

/** Elapsed ms since start, clamped at 0. */
export function elapsedMs(item: WorkItem, now = Date.now()): number {
  return Math.max(0, now - item.startedAt);
}

/** "2m 15s" style duration. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Escape for embedding in HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
