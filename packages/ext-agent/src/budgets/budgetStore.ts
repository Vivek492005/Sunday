// sunday-agent — F1 Cost & Quota Cockpit: hard & soft budgets.
//
// Budgets cap gateway requests per scope:
//   - soft: show a warning (agent keeps going)
//   - hard: pause the agent; user resumes with one-click "continue +N"
//
// BudgetTracker is pure (no vscode import) so the pause/warn semantics are
// unit-tested. Persistence + vscode glue live in commands.ts / the burn
// meter; they only call this class.

/** Budget scope: a single task turn, the chat session, or the calendar day. */
export type BudgetScope = 'task' | 'session' | 'day';

/** Limits for one scope. Omitted = unlimited. Counts are gateway requests. */
export interface BudgetLimit {
  /** Warn when spend reaches this (agent continues). */
  soft?: number;
  /** Pause when spend reaches this (agent stops until continued). */
  hard?: number;
}

export type BudgetEventType = 'soft-warning' | 'hard-pause';

/** Emitted when recordSpend crosses a threshold. */
export interface BudgetEvent {
  type: BudgetEventType;
  scope: BudgetScope;
  spent: number;
  limit: number;
}

const SCOPES: BudgetScope[] = ['task', 'session', 'day'];

/** Pure budget tracker. Call recordSpend(1) per gateway request. */
export class BudgetTracker {
  private spent = new Map<BudgetScope, number>();
  private warned = new Set<BudgetScope>();
  private paused = new Set<BudgetScope>();
  private extra = new Map<BudgetScope, number>();

  constructor(private limits: Partial<Record<BudgetScope, BudgetLimit>> = {}) {}

  /** Effective hard limit including any "continue +N" allowances. */
  hardLimit(scope: BudgetScope): number | undefined {
    const h = this.limits[scope]?.hard;
    if (h === undefined) return undefined;
    return h + (this.extra.get(scope) ?? 0);
  }

  softLimit(scope: BudgetScope): number | undefined {
    return this.limits[scope]?.soft;
  }

  getSpent(scope: BudgetScope): number {
    return this.spent.get(scope) ?? 0;
  }

  isPaused(scope: BudgetScope): boolean {
    return this.paused.has(scope);
  }

  /** True when ANY scope is hard-paused (agent must stop). */
  isPausedAny(): boolean {
    return this.paused.size > 0;
  }

  pausedScopes(): BudgetScope[] {
    return SCOPES.filter((s) => this.paused.has(s));
  }

  /**
   * Record n gateway requests against every configured scope.
   * Returns events for newly-crossed thresholds (each fires once until
   * reset/continued). Never throws.
   */
  recordSpend(n = 1): BudgetEvent[] {
    if (!Number.isFinite(n) || n <= 0) return [];
    const events: BudgetEvent[] = [];
    try {
      for (const scope of SCOPES) {
        const soft = this.limits[scope]?.soft;
        const hard = this.hardLimit(scope);
        if (soft === undefined && hard === undefined) continue;
        const spent = (this.spent.get(scope) ?? 0) + n;
        this.spent.set(scope, spent);
        if (hard !== undefined && spent >= hard && !this.paused.has(scope)) {
          this.paused.add(scope);
          events.push({ type: 'hard-pause', scope, spent, limit: hard });
        } else if (
          soft !== undefined &&
          spent >= soft &&
          !this.warned.has(scope) &&
          !this.paused.has(scope)
        ) {
          this.warned.add(scope);
          events.push({ type: 'soft-warning', scope, spent, limit: soft });
        }
      }
    } catch {
      /* tracking is best-effort */
    }
    return events;
  }

  /**
   * One-click "continue +N": clears the hard pause for a scope and adds n
   * to its effective hard limit. Warn state is kept (already warned).
   */
  continueAllowance(scope: BudgetScope, n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    this.extra.set(scope, (this.extra.get(scope) ?? 0) + Math.floor(n));
    this.paused.delete(scope);
  }

  /** Reset spend/warn/pause state for a scope (new task / session / day). */
  reset(scope: BudgetScope): void {
    this.spent.delete(scope);
    this.warned.delete(scope);
    this.paused.delete(scope);
    this.extra.delete(scope);
  }

  /** Replace limits at runtime (settings change). Keeps spend, clears flags. */
  setLimits(limits: Partial<Record<BudgetScope, BudgetLimit>>): void {
    this.limits = limits;
    this.warned.clear();
    this.paused.clear();
    this.extra.clear();
  }
}

/** Minimal Memento surface for persisting budget config (vscode-free). */
export interface BudgetConfigStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const BUDGET_CFG_KEY = 'sunday.budgets.config.v1';

/** Read saved budget config; returns {} when absent/invalid. */
export function readBudgetConfig(
  store: BudgetConfigStore,
): Partial<Record<BudgetScope, BudgetLimit>> {
  try {
    const v = store.get<Partial<Record<BudgetScope, BudgetLimit>>>(BUDGET_CFG_KEY);
    if (!v || typeof v !== 'object') return {};
    const out: Partial<Record<BudgetScope, BudgetLimit>> = {};
    for (const scope of SCOPES) {
      const lim = (v as Record<string, unknown>)[scope];
      if (lim && typeof lim === 'object') {
        const rec = lim as Record<string, unknown>;
        const soft = typeof rec.soft === 'number' && rec.soft > 0 ? Math.floor(rec.soft) : undefined;
        const hard = typeof rec.hard === 'number' && rec.hard > 0 ? Math.floor(rec.hard) : undefined;
        if (soft !== undefined || hard !== undefined) out[scope] = { soft, hard };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist budget config. Never throws. */
export async function saveBudgetConfig(
  store: BudgetConfigStore,
  cfg: Partial<Record<BudgetScope, BudgetLimit>>,
): Promise<void> {
  try {
    await store.update(BUDGET_CFG_KEY, cfg);
  } catch {
    /* best-effort */
  }
}
