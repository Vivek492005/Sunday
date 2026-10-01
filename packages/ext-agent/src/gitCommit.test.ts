// Tests for `sunday.git.commitMessage`: prompt builder, diff truncation,
// fence stripping, git-extension-present vs absent paths, and the registered
// command handler (SCM inputBox insert). `vscode` is mocked. No DOM, no
// network, no real git.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _fn: (...a: unknown[]) => unknown) => ({ dispose: () => undefined })),
  showInformationMessage: vi.fn(async (..._args: unknown[]) => undefined),
  showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: mocks.registerCommand,
    executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
  },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showErrorMessage: mocks.showErrorMessage,
  },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/ws' } }] },
  extensions: { getExtension: vi.fn(() => undefined) },
}));

import * as vscode from 'vscode';
import {
  COMMIT_MODEL,
  STAGED_DIFF_MAX_CHARS,
  buildCommitPrompt,
  extractCommitMessage,
  findGitRepository,
  getStagedDiff,
  registerGitCommitMessage,
  truncateDiff,
} from './gitCommit.js';
import type { HostBridge } from './hostBridge.js';

function makeBridge(reply: { ok: boolean; text?: string; error?: string }) {
  const listeners = new Set<(n: unknown) => void>();
  return {
    listeners,
    sessionCreate: vi.fn(async () => ({ session: { id: 'sess-1' } })),
    chatSend: vi.fn(async () => {
      setTimeout(() => {
        for (const l of [...listeners])
          l({
            turnId: 'turn-1',
            sessionId: 'sess-1',
            event: reply.ok
              ? { type: 'turn-end', finishReason: 'stop' as const }
              : { type: 'turn-error', code: 500, message: reply.error ?? 'boom' },
          });
      }, 0);
      return { turnId: 'turn-1' };
    }),
    onChatEvent: vi.fn((l: (n: unknown) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
  };
}
// Note: sendAndCollect accumulates text-delta events; the commit command only
// needs the final text, so the streaming fake fires deltas before turn-end.
function makeStreamingBridge(text: string) {
  const b = makeBridge({ ok: true });
  const listeners = b.listeners;
  b.chatSend = vi.fn(async () => {
    setTimeout(() => {
      for (const l of [...listeners])
        l({ turnId: 'turn-1', sessionId: 'sess-1', event: { type: 'text-delta', delta: text } });
      for (const l of [...listeners])
        l({ turnId: 'turn-1', sessionId: 'sess-1', event: { type: 'turn-end', finishReason: 'stop' as const } });
    }, 0);
    return { turnId: 'turn-1' };
  });
  return b;
}
const asBridge = (b: { [k: string]: unknown }): HostBridge => b as unknown as HostBridge;

function commandFn(id: string): (...a: unknown[]) => Promise<unknown> {
  const call = mocks.registerCommand.mock.calls.find((c) => c[0] === id);
  if (!call) throw new Error(`command ${id} not registered`);
  return call[1] as (...a: unknown[]) => Promise<unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// -- pure helpers ----------------------------------------------------------------------

describe('truncateDiff', () => {
  it('leaves short diffs alone', () => {
    expect(truncateDiff('abc')).toEqual({ text: 'abc', truncated: false });
  });
  it('truncates long diffs with a marker', () => {
    const { text, truncated } = truncateDiff('x'.repeat(STAGED_DIFF_MAX_CHARS + 10));
    expect(truncated).toBe(true);
    expect(text).toContain('diff truncated');
    expect(text.length).toBeLessThan(STAGED_DIFF_MAX_CHARS + 200);
  });
});

describe('buildCommitPrompt', () => {
  it('asks for a conventional commit with the 72-char rule', () => {
    const p = buildCommitPrompt('diff --git a/f b/f', false);
    expect(p).toContain('conventional-commit');
    expect(p).toContain('72');
    expect(p).toContain('```diff');
    expect(p).toContain('diff --git a/f b/f');
    expect(p).not.toContain('truncated');
  });
  it('notes truncation when the diff was cut', () => {
    expect(buildCommitPrompt('d', true)).toContain('truncated');
  });
});

describe('extractCommitMessage', () => {
  it('strips fenced blocks with language tags', () => {
    expect(extractCommitMessage('```text\nfeat(api): add endpoint\n```')).toBe('feat(api): add endpoint');
  });
  it('strips bare fences and keeps bodies', () => {
    expect(extractCommitMessage('```\nfix: x\n\nBody line.\n```\n')).toBe('fix: x\n\nBody line.');
  });
  it('leaves plain messages alone', () => {
    expect(extractCommitMessage('  chore: bump  \n')).toBe('chore: bump');
  });
});

// -- git access -------------------------------------------------------------------------

describe('findGitRepository', () => {
  const repo = (root: string) => ({
    diff: async (_staged: boolean) => 'DIFF',
    inputBox: { value: '' },
    rootUri: { fsPath: root },
  });
  it('prefers the repository matching the workspace folder', () => {
    const getExt = () => ({
      exports: { getAPI: (_v: 1) => ({ repositories: [repo('/other'), repo('/ws')] }) },
    });
    expect(findGitRepository(getExt, '/ws')?.rootUri?.fsPath).toBe('/ws');
  });
  it('falls back to the first repository', () => {
    const getExt = () => ({ exports: { getAPI: (_v: 1) => ({ repositories: [repo('/a')] }) } });
    expect(findGitRepository(getExt, '/ws')?.rootUri?.fsPath).toBe('/a');
  });
  it('returns undefined when the git extension is absent', () => {
    expect(findGitRepository(() => undefined, '/ws')).toBeUndefined();
  });
});

describe('getStagedDiff', () => {
  it('uses the vscode.git API when present (staged = true)', async () => {
    const diff = vi.fn(async (_staged: boolean) => 'STAGED-DIFF');
    const getExt = () => ({
      exports: {
        getAPI: (_v: 1) => ({ repositories: [{ diff, inputBox: { value: '' }, rootUri: { fsPath: '/ws' } }] }),
      },
    });
    const res = await getStagedDiff({ getExtension: getExt, workspaceFolder: '/ws' });
    expect(res).toEqual({ diff: 'STAGED-DIFF', via: 'git-extension' });
    expect(diff).toHaveBeenCalledWith(true);
  });
  it('falls back to `git diff --cached` when the git extension is absent', async () => {
    const execGitDiff = vi.fn(async (_cwd: string) => 'CLI-DIFF');
    const res = await getStagedDiff({ getExtension: () => undefined, workspaceFolder: '/ws', execGitDiff });
    expect(res).toEqual({ diff: 'CLI-DIFF', via: 'cli-fallback' });
    expect(execGitDiff).toHaveBeenCalledWith('/ws');
  });
  it('throws when neither source is available', async () => {
    await expect(getStagedDiff({ getExtension: () => undefined })).rejects.toThrow();
  });
});

// -- command ------------------------------------------------------------------------------

describe('registerGitCommitMessage', () => {
  function setup(opts: {
    diff?: string;
    viaExtension?: boolean;
    replyText?: string;
    replyError?: string;
  }) {
    const inputBox = { value: '' };
    const diff = vi.fn(async (_staged: boolean) => opts.diff ?? '');
    const getGitExtension =
      opts.viaExtension === false
        ? () => undefined
        : () => ({
            exports: {
              getAPI: (_v: 1) => ({ repositories: [{ diff, inputBox, rootUri: { fsPath: '/ws' } }] }),
            },
          });
    const execGitDiff = vi.fn(async (_cwd: string) => opts.diff ?? '');
    const bridge = opts.replyError
      ? makeBridge({ ok: false, error: opts.replyError })
      : makeStreamingBridge(opts.replyText ?? 'feat: add thing');
    registerGitCommitMessage({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      ensureBridge: async () => asBridge(bridge),
      getCwd: () => '/ws',
      log: () => undefined,
      execGitDiff,
      getGitExtension,
    });
    return { bridge, inputBox, execGitDiff, diff };
  }

  it('inserts the generated message into the SCM input box', async () => {
    const { bridge, inputBox } = setup({
      diff: 'diff --git a/f b/f\n+new',
      replyText: '```\nfeat(api): add endpoint\n```',
    });
    await commandFn('sunday.git.commitMessage')();
    expect(inputBox.value).toBe('feat(api): add endpoint');
    expect(bridge.chatSend).toHaveBeenCalledTimes(1);
    const sent = (bridge.chatSend.mock.calls[0] as unknown as Array<{ model: string; message: string }>)[0];
    expect(sent.model).toBe(COMMIT_MODEL);
    expect(sent.message).toContain('conventional-commit');
    expect(mocks.showInformationMessage).toHaveBeenCalled();
  });

  it('informs when nothing is staged and never calls the agent', async () => {
    const { bridge } = setup({ diff: '' });
    await commandFn('sunday.git.commitMessage')();
    expect(bridge.chatSend).not.toHaveBeenCalled();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('nothing staged'));
  });

  it('uses the CLI fallback when the git extension is absent, then reports no input box', async () => {
    const { execGitDiff } = setup({ diff: 'some diff', viaExtension: false, replyText: 'fix: x' });
    await commandFn('sunday.git.commitMessage')();
    expect(execGitDiff).toHaveBeenCalledWith('/ws');
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('SCM input box'));
  });

  it('shows an error when the turn fails', async () => {
    setup({ diff: 'some diff', replyError: 'provider down' });
    await commandFn('sunday.git.commitMessage')();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('provider down'));
  });
});
