// sunday-agent — local daily counter for managed-model requests (Task 7).
//
// The hosted gateway is authoritative for the daily managed-request quota
// (it rejects over-quota requests server-side). This counter is a LOCAL
// approximation the model picker uses to grey out managed models once the
// plan's daily limit is reached, without an extra network round-trip per
// keystroke. Keys are per calendar day (local timezone); stale keys are
// pruned opportunistically.

/** Minimal surface of vscode.Memento needed for the counter. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  keys?(): readonly string[];
  update(key: string, value: unknown): Thenable<void>;
}

const USAGE_KEY_PREFIX = 'sunday.managedModels.used.';
/** Keep a week of daily counters; older keys are pruned on record. */
const PRUNE_AFTER_DAYS = 7;

/** `sunday.managedModels.used.2026-10-08` (local calendar day). */
export function usageKeyFor(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${USAGE_KEY_PREFIX}${y}-${m}-${d}`;
}

/** Requests used today (local day). Never throws — 0 on any read problem. */
export function readUsedToday(store: MementoLike, now: Date = new Date()): number {
  try {
    const v = store.get<number>(usageKeyFor(now));
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  } catch {
    return 0;
  }
}

/**
 * Record one managed-model request. Returns the new count. Prunes counters
 * older than a week when the store exposes `keys()`. Never throws.
 */
export async function recordManagedRequest(
  store: MementoLike,
  now: Date = new Date(),
): Promise<number> {
  try {
    const key = usageKeyFor(now);
    const next = readUsedToday(store, now) + 1;
    await store.update(key, next);
    pruneOldKeys(store, now);
    return next;
  } catch {
    return readUsedToday(store, now);
  }
}

function pruneOldKeys(store: MementoLike, now: Date): void {
  try {
    const keys = store.keys?.() ?? [];
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - PRUNE_AFTER_DAYS);
    for (const k of keys) {
      if (!k.startsWith(USAGE_KEY_PREFIX)) continue;
      const day = k.slice(USAGE_KEY_PREFIX.length);
      // Keys are `YYYY-MM-DD`; lexicographic compare works on the format.
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < usageKeyFor(cutoff).slice(USAGE_KEY_PREFIX.length)) {
        void store.update(k, undefined);
      }
    }
  } catch {
    /* pruning is best-effort */
  }
}
