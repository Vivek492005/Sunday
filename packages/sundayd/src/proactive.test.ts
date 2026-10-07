// sundayd — ProactiveEngine tests.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProactiveEngine, lintTargetFor } from './proactive.js';

describe('ProactiveEngine', () => {
  let tmp: string;
  let engine: ProactiveEngine;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'proactive-test-'));
    engine = new ProactiveEngine({ homeDir: tmp, clock: () => 1_700_000_000_000 });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('logAction/history roundtrips, newest first', async () => {
    const a1 = await engine.logAction({ kind: 'lint', target: 'a.js', summary: 'linted a.js' });
    const a2 = await engine.logAction({ kind: 'typecheck', target: 'b.ts', summary: 'checked b.ts' });

    expect(a1.id).toBeTruthy();
    expect(a1.at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(a2.id).not.toBe(a1.id);

    const hist = await engine.history();
    expect(hist).toHaveLength(2);
    expect(hist[0]!.id).toBe(a2.id); // newest first
    expect(hist[1]!.id).toBe(a1.id);
  });

  it('history returns [] when no log file exists', async () => {
    expect(await engine.history()).toEqual([]);
  });

  it('history(limit) caps the result', async () => {
    await engine.logAction({ kind: 'lint', target: 'a.js', summary: 'one' });
    await engine.logAction({ kind: 'lint', target: 'b.js', summary: 'two' });
    await engine.logAction({ kind: 'lint', target: 'c.js', summary: 'three' });
    const hist = await engine.history(2);
    expect(hist).toHaveLength(2);
    expect(hist[0]!.summary).toBe('three');
    expect(hist[1]!.summary).toBe('two');
  });

  it('creates the log directory if it does not exist', async () => {
    const nested = new ProactiveEngine({ homeDir: path.join(tmp, 'nope', 'nested') });
    await nested.logAction({ kind: 'suggestion', target: 'x', summary: 's' });
    const raw = await fs.readFile(nested.getLogPath(), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });

  it('markUndone flips undone and persists it', async () => {
    const a1 = await engine.logAction({ kind: 'lint', target: 'a.js', summary: 'one' });
    const a2 = await engine.logAction({ kind: 'lint', target: 'b.js', summary: 'two' });

    expect(await engine.markUndone(a1.id)).toBe(true);

    const hist = await engine.history();
    const undone = hist.find((a) => a.id === a1.id)!;
    const other = hist.find((a) => a.id === a2.id)!;
    expect(undone.undone).toBe(true);
    expect(other.undone).toBeUndefined();
  });

  it('markUndone returns false for an unknown id', async () => {
    await engine.logAction({ kind: 'lint', target: 'a.js', summary: 'one' });
    expect(await engine.markUndone('does-not-exist')).toBe(false);
  });
});

describe('shouldInvestigate', () => {
  const NOW = 10_000_000;
  const FIVE_MIN = 5 * 60 * 1000;

  it('false when tests are passing, even when idle', () => {
    const e = new ProactiveEngine({ clock: () => NOW });
    expect(e.shouldInvestigate(NOW - 60 * 60 * 1000, false, NOW)).toBe(false);
  });

  it('true when tests fail and idle >= 5 min', () => {
    const e = new ProactiveEngine({ clock: () => NOW });
    expect(e.shouldInvestigate(NOW - FIVE_MIN, true, NOW)).toBe(true);
    expect(e.shouldInvestigate(NOW - FIVE_MIN - 60_000, true, NOW)).toBe(true);
  });

  it('false when idle is 4:59 but true at 5:01 (boundary)', () => {
    const e = new ProactiveEngine({ clock: () => NOW });
    expect(e.shouldInvestigate(NOW - (4 * 60 + 59) * 1000, true, NOW)).toBe(false);
    expect(e.shouldInvestigate(NOW - (5 * 60 + 1) * 1000, true, NOW)).toBe(true);
  });

  it('respects a custom idleMinutes constructor option', () => {
    const e = new ProactiveEngine({ idleMinutes: 10, clock: () => NOW });
    expect(e.shouldInvestigate(NOW - 9 * 60 * 1000, true, NOW)).toBe(false);
    expect(e.shouldInvestigate(NOW - 10 * 60 * 1000, true, NOW)).toBe(true);
  });

  it('uses the injected clock when `now` is omitted', () => {
    const e = new ProactiveEngine({ clock: () => NOW });
    expect(e.shouldInvestigate(NOW - FIVE_MIN, true)).toBe(true);
    expect(e.shouldInvestigate(NOW - 1000, true)).toBe(false);
  });
});

describe('lintTargetFor', () => {
  it.each([
    ['src/a.ts', 'typecheck'],
    ['src/b.tsx', 'typecheck'],
    ['src/C.TS', 'typecheck'],
    ['src/a.js', 'lint'],
    ['src/b.jsx', 'lint'],
    ['src/c.mjs', 'lint'],
  ])('maps %s to %s', (file, expected) => {
    expect(lintTargetFor(file)).toBe(expected);
  });

  it.each([['src/a.css'], ['README.md'], ['src/a.cjs'], ['Makefile'], ['no-ext']])(
    'maps %s to null',
    (file) => {
      expect(lintTargetFor(file)).toBe(null);
    },
  );
});
