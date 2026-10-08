// Tests for the browser-agent gate and the local managed-model usage
// counter. Pure — no vscode, no network.
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_PLAN_MESSAGE, browserAllowedByView } from './browserGating.js';
import { indexCapMessage, maxIndexBytes } from './indexGating.js';
import { readUsedToday, recordManagedRequest, usageKeyFor, type MementoLike } from './usage.js';
import { makeView } from './testFixtures.js';

function makeStore(initial: Record<string, unknown> = {}): MementoLike {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T,>(key: string) => data.get(key) as T | undefined,
    keys: () => [...data.keys()],
    update: async (key: string, value: unknown) => {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
  };
}

describe('browserAllowedByView', () => {
  it('fails open when entitlements are unknown', () => {
    expect(browserAllowedByView(undefined)).toBe(true);
  });

  it('denies when browser_agent.enabled is false', () => {
    expect(browserAllowedByView(makeView({ 'browser_agent.enabled': false }))).toBe(false);
  });

  it('allows when browser_agent.enabled is true', () => {
    expect(browserAllowedByView(makeView({ 'browser_agent.enabled': true }))).toBe(true);
  });

  it('exposes the product-specified upsell copy', () => {
    expect(BROWSER_PLAN_MESSAGE).toBe('Browser agent requires a Smart plan or higher');
  });
});

describe('maxIndexBytes', () => {
  it('defaults to 100 MB when entitlements are unknown', () => {
    expect(maxIndexBytes(undefined)).toBe(100 * 1024 * 1024);
  });

  it('derives the cap from codebase_index.max_repo_mb', () => {
    expect(maxIndexBytes(makeView({ 'codebase_index.max_repo_mb': 500 }))).toBe(500 * 1024 * 1024);
  });
});

describe('indexCapMessage', () => {
  it('formats the plan-limit message', () => {
    expect(indexCapMessage(500 * 1024 * 1024)).toBe('Indexing stopped at 500 MB — your plan\'s limit');
  });
});

describe('managed-model usage counter', () => {
  const day = new Date(2026, 9, 8, 12, 0, 0); // 2026-10-08 local

  it('keys counters by local calendar day', () => {
    expect(usageKeyFor(day)).toBe('sunday.managedModels.used.2026-10-08');
  });

  it('reads 0 for a fresh day', () => {
    expect(readUsedToday(makeStore(), day)).toBe(0);
  });

  it('increments per managed request and reads back', async () => {
    const store = makeStore();
    await recordManagedRequest(store, day);
    await recordManagedRequest(store, day);
    expect(readUsedToday(store, day)).toBe(2);
    // a different day starts at 0
    expect(readUsedToday(store, new Date(2026, 9, 9))).toBe(0);
  });

  it('never throws on a broken store', async () => {
    const broken: MementoLike = {
      get: () => {
        throw new Error('nope');
      },
      update: async () => {
        throw new Error('nope');
      },
    };
    expect(readUsedToday(broken, day)).toBe(0);
    await expect(recordManagedRequest(broken, day)).resolves.toBe(0);
  });

  it('prunes counters older than a week', async () => {
    const store = makeStore({ 'sunday.managedModels.used.2026-09-30': 5 });
    const update = vi.spyOn(store, 'update');
    await recordManagedRequest(store, day);
    expect(update).toHaveBeenCalledWith('sunday.managedModels.used.2026-09-30', undefined);
    expect(readUsedToday(store, day)).toBe(1);
  });
});
