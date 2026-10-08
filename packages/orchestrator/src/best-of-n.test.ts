// Tests for the A2 best-of-N core: N variants produced, temperatures and
// angles cycle, failures are captured per-attempt, winner selection
// validates, and empty diffs are valid outcomes.
import { describe, expect, it, vi } from 'vitest';
import {
  BEST_OF_N_ANGLES,
  BEST_OF_N_MAX_ATTEMPTS,
  BEST_OF_N_TEMPERATURES,
  attemptConfig,
  buildAttemptSystemPrompt,
  pickWinner,
  runBestOfN,
  type BestOfNAttemptInput,
  type BestOfNAttemptResult,
} from './best-of-n.js';

function okExecutor(seen: BestOfNAttemptInput[] = []) {
  return vi.fn(async (input: BestOfNAttemptInput) => {
    seen.push(input);
    return {
      summary: `did ${input.attemptId}`,
      diff: `diff --git a/f${input.attemptIndex}.ts b/f${input.attemptIndex}.ts`,
      filesChanged: [`f${input.attemptIndex}.ts`],
    };
  });
}

describe('attemptConfig', () => {
  it('cycles temperatures 0.2/0.7/1.0 and angles conservative/balanced/creative', () => {
    expect([...BEST_OF_N_TEMPERATURES]).toEqual([0.2, 0.7, 1.0]);
    expect([...BEST_OF_N_ANGLES]).toEqual(['conservative', 'balanced', 'creative']);
    const cfgs = [0, 1, 2, 3, 4, 5].map(attemptConfig);
    expect(cfgs.map((c) => c.temperature)).toEqual([0.2, 0.7, 1.0, 0.2, 0.7, 1.0]);
    expect(cfgs.map((c) => c.angle)).toEqual([
      'conservative', 'balanced', 'creative',
      'conservative', 'balanced', 'creative',
    ]);
  });

  it('builds angle-specific system prompts', () => {
    const p = buildAttemptSystemPrompt('creative', 'base prompt');
    expect(p).toContain('base prompt');
    expect(p).toContain('creative');
    expect(buildAttemptSystemPrompt('conservative')).toContain('conservative');
    expect(buildAttemptSystemPrompt('conservative')).not.toContain('creative');
  });
});

describe('runBestOfN', () => {
  it('produces N variants with distinct configs', async () => {
    const seen: BestOfNAttemptInput[] = [];
    const { attempts } = await runBestOfN({
      goal: 'add a button',
      attempts: 3,
      workdir: '/tmp/w',
      execute: okExecutor(seen),
    });
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.id)).toEqual(['attempt-1', 'attempt-2', 'attempt-3']);
    expect(attempts.map((a) => a.temperature)).toEqual([0.2, 0.7, 1.0]);
    expect(attempts.map((a) => a.angle)).toEqual(['conservative', 'balanced', 'creative']);
    // The executor saw the same matrix.
    expect(seen.map((s) => s.temperature)).toEqual([0.2, 0.7, 1.0]);
    expect(seen.every((s) => s.goal === 'add a button' && s.workdir === '/tmp/w')).toBe(true);
  });

  it('runs variants concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { attempts } = await runBestOfN({
      goal: 'g',
      attempts: 4,
      workdir: '/tmp/w',
      execute: async (input) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { summary: input.attemptId, diff: '', filesChanged: [] };
      },
    });
    expect(attempts).toHaveLength(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('captures a failing variant as an error-attempt without failing the batch', async () => {
    const { attempts } = await runBestOfN({
      goal: 'g',
      attempts: 3,
      workdir: '/tmp/w',
      execute: async (input) => {
        if (input.attemptIndex === 1) throw new Error('model blew up');
        return { summary: 'ok', diff: 'd', filesChanged: ['f'] };
      },
    });
    expect(attempts[1]!.error).toContain('model blew up');
    expect(attempts[1]!.diff).toBe('');
    expect(attempts[0]!.error).toBeUndefined();
    expect(attempts[2]!.error).toBeUndefined();
  });

  it('treats an empty diff as a valid (no-change) outcome', async () => {
    const { attempts } = await runBestOfN({
      goal: 'g',
      attempts: 1,
      workdir: '/tmp/w',
      execute: async () => ({ summary: 'nothing to do', diff: '', filesChanged: [] }),
    });
    expect(attempts[0]!.error).toBeUndefined();
    expect(attempts[0]!.diff).toBe('');
    expect(attempts[0]!.filesChanged).toEqual([]);
  });

  it('rejects bad inputs', async () => {
    const ex = okExecutor();
    await expect(runBestOfN({ goal: '  ', attempts: 2, workdir: '/w', execute: ex })).rejects.toThrow(/goal/);
    await expect(runBestOfN({ goal: 'g', attempts: 0, workdir: '/w', execute: ex })).rejects.toThrow(/1\.\./);
    await expect(runBestOfN({ goal: 'g', attempts: BEST_OF_N_MAX_ATTEMPTS + 1, workdir: '/w', execute: ex })).rejects.toThrow(/1\.\./);
    await expect(runBestOfN({ goal: 'g', attempts: 2, workdir: '', execute: ex })).rejects.toThrow(/workdir/);
    expect(ex).not.toHaveBeenCalled();
  });
});

describe('pickWinner', () => {
  const attempts: BestOfNAttemptResult[] = [
    { id: 'attempt-1', temperature: 0.2, angle: 'conservative', summary: 's1', diff: 'd1', filesChanged: ['a'] },
    { id: 'attempt-2', temperature: 0.7, angle: 'balanced', summary: '', diff: '', filesChanged: [], error: 'boom' },
  ];

  it('returns the chosen attempt', () => {
    expect(pickWinner(attempts, 0).id).toBe('attempt-1');
  });

  it('rejects out-of-range indexes', () => {
    expect(() => pickWinner(attempts, -1)).toThrow(/out of range/);
    expect(() => pickWinner(attempts, 2)).toThrow(/out of range/);
    expect(() => pickWinner([], 0)).toThrow(/out of range/);
  });

  it('refuses to pick a failed attempt', () => {
    expect(() => pickWinner(attempts, 1)).toThrow(/failed/);
  });
});
