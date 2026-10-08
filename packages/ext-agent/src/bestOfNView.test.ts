// Tests for the A2 comparison view: HTML rendering (cards, diff preview,
// escaping, pick buttons), winner validation, and command registration.
// `vscode` is mocked; HostBridge is a stub.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const registered = new Map<string, (...args: any[]) => unknown>();
  return {
    registered,
    window: {
      showInputBox: vi.fn(),
      showQuickPick: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      withProgress: vi.fn(async (_opts: any, task: (p: any) => unknown) => task({ report: () => undefined })),
      createWebviewPanel: vi.fn(() => ({
        webview: { html: '', onDidReceiveMessage: vi.fn() },
        onDidDispose: vi.fn(),
        dispose: vi.fn(),
        reveal: vi.fn(),
      })),
    },
    commands: {
      registerCommand: vi.fn((id: string, fn: (...args: any[]) => unknown) => {
        registered.set(id, fn);
        return { dispose: () => undefined };
      }),
    },
    workspace: { getConfiguration: vi.fn(() => ({ get: (_k: string, def: unknown) => def })) },
    ViewColumn: { One: 1 },
    ProgressLocation: { Notification: 15 },
  };
});

vi.mock('vscode', () => ({
  window: mocks.window,
  commands: mocks.commands,
  workspace: mocks.workspace,
  ViewColumn: mocks.ViewColumn,
  ProgressLocation: mocks.ProgressLocation,
}));

import {
  BEST_OF_N_RUN_COMMAND,
  escapeHtml,
  registerBestOfN,
  renderBestOfNHtml,
  validateWinnerPick,
} from './bestOfNView.js';
import type { BestofnAttempt } from '@sunday/protocol';

const ATTEMPTS: BestofnAttempt[] = [
  {
    id: 'attempt-1', temperature: 0.2, angle: 'conservative',
    summary: 'Added validation', diff: 'diff --git a/x b/x\n+safe',
    filesChanged: ['x.ts'], worktree: '/tmp/wt1', branch: 'sunday/bestofn/a1',
  },
  {
    id: 'attempt-2', temperature: 0.7, angle: 'balanced',
    summary: '', diff: '', filesChanged: [], worktree: '/tmp/wt2',
    branch: 'sunday/bestofn/a2', error: 'agent exploded',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registered.clear();
});

describe('escapeHtml', () => {
  it('escapes markup', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });
});

describe('renderBestOfNHtml', () => {
  it('renders a card per attempt with diff preview and pick buttons', () => {
    const html = renderBestOfNHtml('add validation', ATTEMPTS);
    expect(html).toContain('attempt-1');
    expect(html).toContain('attempt-2');
    expect(html).toContain('conservative');
    expect(html).toContain('t=0.2');
    expect(html).toContain('diff --git a/x b/x');
    expect(html).toContain('x.ts');
    // Pick buttons: one per attempt; the failed one is disabled.
    expect(html.match(/data-pick="0"/)).toBeTruthy();
    expect(html.match(/data-pick="1"[^>]*disabled|disabled[^>]*data-pick="1"/)).toBeTruthy();
    expect(html).toContain('failed');
  });

  it('escapes attempt content (no script injection via diffs)', () => {
    const evil: BestofnAttempt = {
      ...ATTEMPTS[0]!,
      summary: '<img src=x onerror=alert(1)>',
      diff: '</pre><script>alert(2)</script>',
    };
    const html = renderBestOfNHtml('<b>goal</b>', [evil]);
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;script&gt;alert(2)');
    expect(html).toContain('&lt;b&gt;goal&lt;/b&gt;');
  });

  it('truncates huge diffs', () => {
    const big: BestofnAttempt = { ...ATTEMPTS[0]!, diff: 'x'.repeat(10_000) };
    const html = renderBestOfNHtml('g', [big]);
    expect(html).toContain('(truncated)');
    expect(html.length).toBeLessThan(10_000 + 6000);
  });

  it('handles the empty-result case', () => {
    const html = renderBestOfNHtml('g', []);
    expect(html).toContain('No attempts were produced');
  });

  it('shows "No changes" for empty diffs', () => {
    const html = renderBestOfNHtml('g', [{ ...ATTEMPTS[0]!, diff: '', filesChanged: [] }]);
    expect(html).toContain('No changes');
  });
});

describe('validateWinnerPick', () => {
  it('accepts a valid pick', () => {
    expect(validateWinnerPick(ATTEMPTS, 0).id).toBe('attempt-1');
  });

  it('rejects bad indexes', () => {
    expect(() => validateWinnerPick(ATTEMPTS, 5)).toThrow(/out of range/);
    expect(() => validateWinnerPick(ATTEMPTS, -1)).toThrow(/out of range/);
  });

  it('rejects failed attempts and attempts without a worktree', () => {
    expect(() => validateWinnerPick(ATTEMPTS, 1)).toThrow(/failed/);
    expect(() => validateWinnerPick([{ ...ATTEMPTS[0]!, worktree: '' }], 0)).toThrow(/worktree/);
  });
});

describe('registerBestOfN', () => {
  function makeDeps() {
    const bridge = {
      bestofnRun: vi.fn(async () => ({ attempts: ATTEMPTS })),
      worktreeMerge: vi.fn(async () => ({ merged: true, sha: 'abc123def456', target: 'main' })),
    };
    return {
      deps: {
        getBridge: async () => bridge as never,
        getCwd: () => '/repo',
        log: vi.fn(),
      },
      bridge,
    };
  }

  it('registers sunday.bestOfN.run', () => {
    const { deps } = makeDeps();
    const ctx = { subscriptions: [] as unknown[] } as unknown as import('vscode').ExtensionContext;
    registerBestOfN(ctx, deps);
    expect(mocks.registered.has(BEST_OF_N_RUN_COMMAND)).toBe(true);
  });

  it('runs the command end-to-end: prompts, runs, opens the panel', async () => {
    const { deps, bridge } = makeDeps();
    const ctx = { subscriptions: [] as unknown[] } as unknown as import('vscode').ExtensionContext;
    registerBestOfN(ctx, deps);
    mocks.window.showInputBox.mockResolvedValueOnce('add validation');
    mocks.window.showQuickPick.mockResolvedValueOnce('3');
    await (mocks.registered.get(BEST_OF_N_RUN_COMMAND) as () => Promise<void>)();
    expect(bridge.bestofnRun).toHaveBeenCalledWith({ goal: 'add validation', attempts: 3, workdir: '/repo' });
    expect(mocks.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    const panel = mocks.window.createWebviewPanel.mock.results[0]!.value;
    expect(panel.webview.html).toContain('attempt-1');
  });

  it('no-ops when prompts are dismissed and errors without a workdir', async () => {
    const { deps, bridge } = makeDeps();
    const ctx = { subscriptions: [] as unknown[] } as unknown as import('vscode').ExtensionContext;
    registerBestOfN(ctx, { ...deps, getCwd: () => undefined });
    mocks.window.showInputBox.mockResolvedValueOnce(undefined);
    await (mocks.registered.get(BEST_OF_N_RUN_COMMAND) as () => Promise<void>)();
    expect(bridge.bestofnRun).not.toHaveBeenCalled();

    mocks.window.showInputBox.mockResolvedValueOnce('goal');
    await (mocks.registered.get(BEST_OF_N_RUN_COMMAND) as () => Promise<void>)();
    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('workspace folder'));
  });

  it('pick-winner merges the worktree via worktreeMerge', async () => {
    const { deps, bridge } = makeDeps();
    const ctx = { subscriptions: [] as unknown[] } as unknown as import('vscode').ExtensionContext;
    registerBestOfN(ctx, deps);
    mocks.window.showInputBox.mockResolvedValueOnce('g');
    mocks.window.showQuickPick.mockResolvedValueOnce('2');
    await (mocks.registered.get(BEST_OF_N_RUN_COMMAND) as () => Promise<void>)();
    const panel = mocks.window.createWebviewPanel.mock.results[0]!.value;
    const onMsg = panel.webview.onDidReceiveMessage.mock.calls[0]![0] as (m: unknown) => void;
    // Pick the failed attempt → error, no merge.
    onMsg({ command: 'pickWinner', index: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge.worktreeMerge).not.toHaveBeenCalled();
    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('failed'));
    // Pick the winner → worktreeMerge with the attempt's worktree.
    (mocks.window.showErrorMessage as ReturnType<typeof vi.fn>).mockClear();
    onMsg({ command: 'pickWinner', index: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge.worktreeMerge).toHaveBeenCalledWith({ repoRoot: '/repo', path: '/tmp/wt1' });
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('merged'));
  });
});
