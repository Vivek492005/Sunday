// sunday-agent — F1 Cost & Quota Cockpit: task ledger + cost-per-success.
//
// Cost-per-successful-task counts ONLY tasks where the verifier passed —
// the industry-almost-nobody-has-it metric from the F1 spec. Pure logic,
// unit-tested; the "verifier passed" signal comes from the caller (chat
// turn-end with a passing verification step).

/** One finished task turn, as recorded for cost analytics. */
export interface TaskRecord {
  /** Stable id (turn id). */
  id: string;
  /** Model id used. */
  model: string;
  /** Gateway requests consumed by the task. */
  requests: number;
  /** Verifier passed → counts as a *successful* task. */
  success: boolean;
  /** Epoch ms. */
  at: number;
}

/**
 * Average requests per successful task. Undefined when no successful task
 * is recorded yet. Pure function over records.
 */
export function costPerSuccessfulTask(records: TaskRecord[]): number | undefined {
  const ok = records.filter((r) => r.success && r.requests > 0);
  if (ok.length === 0) return undefined;
  const total = ok.reduce((a, r) => a + r.requests, 0);
  return total / ok.length;
}

/** Fraction of recorded tasks that succeeded (0..1). Undefined when empty. */
export function taskSuccessRate(records: TaskRecord[]): number | undefined {
  if (records.length === 0) return undefined;
  return records.filter((r) => r.success).length / records.length;
}

/**
 * In-memory rolling ledger of task records. Bounded (default 200) so it
 * can't grow without limit; oldest records roll off.
 */
export class TaskLedger {
  private records: TaskRecord[] = [];

  constructor(private readonly maxRecords = 200) {}

  record(r: TaskRecord): void {
    if (!r || typeof r.id !== 'string' || !Number.isFinite(r.requests) || r.requests < 0) return;
    this.records.push({ ...r });
    while (this.records.length > this.maxRecords) this.records.shift();
  }

  /** Rolling average requests/task — feeds the pre-run estimator. */
  averageRequests(): number | undefined {
    const withReq = this.records.filter((r) => r.requests > 0);
    if (withReq.length === 0) return undefined;
    return withReq.reduce((a, r) => a + r.requests, 0) / withReq.length;
  }

  costPerSuccessfulTask(): number | undefined {
    return costPerSuccessfulTask(this.records);
  }

  successRate(): number | undefined {
    return taskSuccessRate(this.records);
  }

  successfulCount(): number {
    return this.records.filter((r) => r.success).length;
  }

  size(): number {
    return this.records.length;
  }

  /** Snapshot for the usage view (copy). */
  snapshot(): TaskRecord[] {
    return this.records.map((r) => ({ ...r }));
  }
}
