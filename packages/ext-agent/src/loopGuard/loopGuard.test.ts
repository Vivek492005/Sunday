// Tests for loopGuard/ — F2 Loop Breaker detectors, hashing, and
// breaker semantics (stays open until acknowledge/reset; false positives).
import { describe, expect, it } from 'vitest';
import {
  LoopGuard,
  inferProgressSignals,
  errorSignature,
  hashToolCall,
  normalizeArgs,
} from './index.js';

/** Drive one full call through the guard; returns any trigger. */
function drive(
  guard: LoopGuard,
  tool: string,
  args: Record<string, unknown>,
  result: { isError?: boolean; resultText?: string; inputTokens?: number; outputTokens?: number } = {},
) {
  const { token, trigger: pre } = guard.preCall(tool, args);
  if (pre) return pre;
  return guard.postResult(token, { tool, isError: result.isError ?? false, ...result });
}

describe('hashing', () => {
  it('normalizeArgs is order-insensitive', () => {
    expect(normalizeArgs({ a: 1, b: 2 })).toBe(normalizeArgs({ b: 2, a: 1 }));
  });

  it('redacts secret-looking values so rotated keys hash alike', () => {
    const h1 = hashToolCall('web_fetch', { url: 'https://x', api_key: 'aaa' });
    const h2 = hashToolCall('web_fetch', { url: 'https://x', api_key: 'bbb' });
    expect(h1).toBe(h2);
  });

  it('distinguishes genuinely different args', () => {
    expect(hashToolCall('run_terminal', { command: 'ls' })).not.toBe(
      hashToolCall('run_terminal', { command: 'rm -rf /' }),
    );
  });

  it('errorSignature is stable across volatile bits', () => {
    const a = errorSignature("Error: ENOENT: no such file '/tmp/a.log' at 2026-10-18T12:34:56Z (code 2)");
    const b = errorSignature("Error: ENOENT: no such file '/tmp/b.log' at 2026-10-18T12:35:01Z (code 7)");
    expect(a).toBe(b);
  });

  it('errorSignature differs for different failures', () => {
    expect(errorSignature('Error: ENOENT: no such file')).not.toBe(
      errorSignature('TypeError: cannot read property of undefined'),
    );
  });
});

describe('detector 1: repeated tool + args', () => {
  it('trips on the 3rd identical call (threshold 3)', () => {
    const g = new LoopGuard();
    const args = { command: 'npm test -- --run broken.spec.ts' };
    expect(drive(g, 'run_terminal', args)).toBeUndefined();
    expect(drive(g, 'run_terminal', args)).toBeUndefined();
    const t = drive(g, 'run_terminal', args);
    expect(t?.kind).toBe('repeated-tool-args');
    expect(t?.count).toBe(3);
    expect(t?.suggestedActions).toContain('change-strategy');
  });

  it('does not trip on varied calls', () => {
    const g = new LoopGuard();
    expect(drive(g, 'read_file', { path: '/a.ts' })).toBeUndefined();
    expect(drive(g, 'read_file', { path: '/b.ts' })).toBeUndefined();
    expect(drive(g, 'list_dir', { path: '/' })).toBeUndefined();
    expect(drive(g, 'search', { query: 'foo' })).toBeUndefined();
    expect(drive(g, 'read_file', { path: '/c.ts' })).toBeUndefined();
    expect(g.tripped).toBe(false);
  });

  it('custom threshold is honored', () => {
    const g = new LoopGuard({ threshold: 2 });
    const args = { path: '/x' };
    expect(drive(g, 'read_file', args)).toBeUndefined();
    expect(drive(g, 'read_file', args)?.kind).toBe('repeated-tool-args');
  });
});

describe('detector 2: repeated failure', () => {
  const fail = (file: string) => ({
    isError: true,
    resultText: `Error: ENOENT: no such file or directory, open '/tmp/${file}'`,
  });

  it('trips on the 3rd same failure', () => {
    const g = new LoopGuard();
    // Use different tools/args so detector 1 stays quiet; same error text.
    expect(drive(g, 'read_file', { path: '/a' }, fail('a'))).toBeUndefined();
    expect(drive(g, 'read_file', { path: '/b' }, fail('b'))).toBeUndefined();
    const t = drive(g, 'read_file', { path: '/c' }, fail('c'));
    expect(t?.kind).toBe('repeated-failure');
    expect(t?.count).toBe(3);
  });

  it('does not trip on different failures', () => {
    const g = new LoopGuard();
    expect(drive(g, 'read_file', { path: '/a' }, { isError: true, resultText: 'ENOENT no such file' })).toBeUndefined();
    expect(drive(g, 'read_file', { path: '/b' }, { isError: true, resultText: 'EACCES permission denied' })).toBeUndefined();
    expect(drive(g, 'read_file', { path: '/c' }, { isError: true, resultText: 'EISDIR illegal operation on directory' })).toBeUndefined();
    expect(g.tripped).toBe(false);
  });

  it('does not trip on successes', () => {
    const g = new LoopGuard();
    for (const p of ['/a', '/b', '/c']) {
      expect(drive(g, 'read_file', { path: p }, { resultText: 'ok' })).toBeUndefined();
    }
    expect(g.tripped).toBe(false);
  });
});

describe('detector 3: apply-revert ping-pong', () => {
  const edit = (content: string) => ({ path: '/app.ts', content });

  it('trips on A,B,A flip-flop', () => {
    const g = new LoopGuard();
    expect(drive(g, 'write_file', edit('const a = 1;'))).toBeUndefined();
    expect(drive(g, 'write_file', edit('const a = 2;'))).toBeUndefined();
    const t = drive(g, 'write_file', edit('const a = 1;'));
    expect(t?.kind).toBe('apply-revert-pingpong');
    expect(t?.evidence.filePath).toBe('/app.ts');
  });

  it('does not trip on three distinct states', () => {
    const g = new LoopGuard();
    expect(drive(g, 'write_file', edit('a'))).toBeUndefined();
    expect(drive(g, 'write_file', edit('b'))).toBeUndefined();
    expect(drive(g, 'write_file', edit('c'))).toBeUndefined();
    expect(g.tripped).toBe(false);
  });

  it('does not trip across different files', () => {
    const g = new LoopGuard();
    expect(drive(g, 'write_file', { path: '/x.ts', content: 'a' })).toBeUndefined();
    expect(drive(g, 'write_file', { path: '/y.ts', content: 'a' })).toBeUndefined();
    expect(drive(g, 'write_file', { path: '/x.ts', content: 'a' })).toBeUndefined();
    expect(g.tripped).toBe(false);
  });
});

describe('detector 4: spend vs progress divergence', () => {
  const pricey = { inputTokens: 400, outputTokens: 100 };

  it('trips when tokens burn with no progress', () => {
    const g = new LoopGuard({ divergenceMinTokens: 1000, divergenceMinCalls: 4 });
    for (let i = 0; i < 3; i++) {
      expect(drive(g, 'read_file', { path: `/f${i}.ts` }, { ...pricey, resultText: 'ok' })).toBeUndefined();
    }
    const t = drive(g, 'search', { query: 'q' }, { ...pricey, resultText: 'ok' });
    expect(t?.kind).toBe('spend-no-progress');
    expect(t?.evidence.windowTokens).toBeGreaterThanOrEqual(1000);
  });

  it('does not trip when files changed', () => {
    const g = new LoopGuard({ divergenceMinTokens: 1000, divergenceMinCalls: 4 });
    for (let i = 0; i < 3; i++) {
      drive(g, 'read_file', { path: `/f${i}.ts` }, { ...pricey, resultText: 'ok' });
    }
    // A successful write = progress → resets the divergence story.
    expect(drive(g, 'write_file', { path: '/out.ts', content: 'x' }, { ...pricey, resultText: 'ok' })).toBeUndefined();
    expect(g.tripped).toBe(false);
  });

  it('does not trip when a test run passed', () => {
    const g = new LoopGuard({ divergenceMinTokens: 1000, divergenceMinCalls: 4 });
    for (let i = 0; i < 3; i++) {
      drive(g, 'read_file', { path: `/f${i}.ts` }, { ...pricey, resultText: 'ok' });
    }
    expect(
      drive(g, 'run_terminal', { command: 'pnpm vitest run' }, { ...pricey, resultText: 'ok' }),
    ).toBeUndefined();
    expect(g.tripped).toBe(false);
  });

  it('does not trip below the token floor', () => {
    const g = new LoopGuard({ divergenceMinTokens: 100_000, divergenceMinCalls: 2 });
    expect(drive(g, 'read_file', { path: '/a' }, pricey)).toBeUndefined();
    expect(drive(g, 'read_file', { path: '/b' }, pricey)).toBeUndefined();
    expect(g.tripped).toBe(false);
  });
});

describe('breaker semantics', () => {
  it('stays open after tripping until acknowledge()', () => {
    const g = new LoopGuard();
    const args = { command: 'loop-forever' };
    drive(g, 'run_terminal', args);
    drive(g, 'run_terminal', args);
    expect(drive(g, 'run_terminal', args)?.kind).toBe('repeated-tool-args');
    expect(g.tripped).toBe(true);
    // Further calls: no new trigger while open.
    expect(drive(g, 'run_terminal', args)).toBeUndefined();
    // acknowledge() re-arms; the same stuck behavior trips again.
    g.acknowledge();
    expect(g.tripped).toBe(false);
    expect(drive(g, 'run_terminal', args)?.kind).toBe('repeated-tool-args');
  });

  it('reset() clears history and re-arms', () => {
    const g = new LoopGuard();
    const args = { command: 'x' };
    drive(g, 'run_terminal', args);
    drive(g, 'run_terminal', args);
    g.reset();
    expect(g.tripped).toBe(false);
    expect(g.snapshot()).toHaveLength(0);
    expect(drive(g, 'run_terminal', args)).toBeUndefined();
  });

  it('disabled policy never trips', () => {
    const g = new LoopGuard({ enabled: false });
    const args = { command: 'x' };
    for (let i = 0; i < 5; i++) drive(g, 'run_terminal', args);
    expect(g.tripped).toBe(false);
    expect(g.snapshot()).toHaveLength(0);
  });
});

describe('inferProgressSignals', () => {
  it('counts successful writes as file changes', () => {
    expect(inferProgressSignals('write_file', { path: '/a' }, false)).toEqual({ filesChanged: 1, testsPassed: false });
    expect(inferProgressSignals('edit_file', { path: '/a' }, false)).toEqual({ filesChanged: 1, testsPassed: false });
  });

  it('failed writes are not progress', () => {
    expect(inferProgressSignals('write_file', { path: '/a' }, true)).toEqual({ filesChanged: 0, testsPassed: false });
  });

  it('detects test runs via run_terminal', () => {
    expect(inferProgressSignals('run_terminal', { command: 'pnpm vitest run' }, false).testsPassed).toBe(true);
    expect(inferProgressSignals('run_terminal', { command: 'pytest -q' }, false).testsPassed).toBe(true);
    expect(inferProgressSignals('run_terminal', { command: 'ls -la' }, false).testsPassed).toBe(false);
    // Failed test run is not "passed".
    expect(inferProgressSignals('run_terminal', { command: 'npm test' }, true).testsPassed).toBe(false);
  });

  it('reads are not progress', () => {
    expect(inferProgressSignals('read_file', { path: '/a' }, false)).toEqual({ filesChanged: 0, testsPassed: false });
  });
});
