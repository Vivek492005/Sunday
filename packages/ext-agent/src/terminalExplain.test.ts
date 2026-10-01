// Tests for `sunday.terminal.explainError`: prompt builder, output
// truncation, the shell-integration failure tracker, and the command
// handler incl. the paste fallback. `vscode` is mocked. No DOM, no network.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _fn: (...a: unknown[]) => unknown) => ({ dispose: () => undefined })),
  showInputBox: vi.fn(async (..._args: unknown[]) => undefined as unknown as string | undefined),
  showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined),
  onDidEndTerminalShellExecution: vi.fn((_l: (e: unknown) => unknown) => ({ dispose: () => undefined })),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: mocks.registerCommand,
    executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
  },
  window: {
    showInputBox: mocks.showInputBox,
    showErrorMessage: mocks.showErrorMessage,
    onDidEndTerminalShellExecution: mocks.onDidEndTerminalShellExecution,
  },
}));

import * as vscode from 'vscode';
import {
  FailureTracker,
  buildTerminalErrorPrompt,
  readExecutionOutput,
  registerTerminalExplain,
  truncateTerminalOutput,
  TERMINAL_OUTPUT_MAX_CHARS,
} from './terminalExplain.js';
import type { HostBridge } from './hostBridge.js';

function makeBridge() {
  return {
    sessionCreate: vi.fn(async () => ({ session: { id: 'sess-1' } })),
    chatSend: vi.fn(async () => ({ turnId: 'turn-1' })),
    onChatEvent: vi.fn(() => () => undefined),
  };
}
const asBridge = (b: ReturnType<typeof makeBridge>): HostBridge => b as unknown as HostBridge;

function shellListener(): (e: unknown) => Promise<unknown> {
  const call = mocks.onDidEndTerminalShellExecution.mock.calls[0];
  if (!call) throw new Error('shell listener not registered');
  return call[0] as (e: unknown) => Promise<unknown>;
}

function commandFn(id: string): (...a: unknown[]) => Promise<unknown> {
  const call = mocks.registerCommand.mock.calls.find((c) => c[0] === id);
  if (!call) throw new Error(`command ${id} not registered`);
  return call[1] as (...a: unknown[]) => Promise<unknown>;
}

function setup() {
  const bridge = makeBridge();
  const context = { subscriptions: [] as unknown[] } as unknown as vscode.ExtensionContext;
  registerTerminalExplain(context, {
    ensureBridge: async () => asBridge(bridge),
    getCwd: () => '/ws',
    log: () => undefined,
  });
  return { bridge, context };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  vi.clearAllMocks();
});

// -- pure helpers ---------------------------------------------------------------------------

describe('truncateTerminalOutput', () => {
  it('keeps short output intact', () => {
    expect(truncateTerminalOutput('err')).toEqual({ output: 'err', truncated: false });
  });
  it('keeps the tail of long output with a marker', () => {
    const out = 'x'.repeat(TERMINAL_OUTPUT_MAX_CHARS) + 'TAIL-ERROR';
    const { output, truncated } = truncateTerminalOutput(out);
    expect(truncated).toBe(true);
    expect(output.endsWith('TAIL-ERROR')).toBe(true);
    expect(output).toContain('truncated');
  });
});

describe('buildTerminalErrorPrompt', () => {
  it('includes command, exit code and output', () => {
    const p = buildTerminalErrorPrompt({ command: 'npm test', exitCode: 1, output: 'FAIL boom' });
    expect(p).toContain('npm test');
    expect(p).toContain('Exit code: 1');
    expect(p).toContain('FAIL boom');
    expect(p).toContain('suggest a concrete fix');
  });
  it('works without an exit code (pasted output)', () => {
    const p = buildTerminalErrorPrompt({ command: '(pasted error output)', output: 'oops' });
    expect(p).not.toContain('Exit code');
    expect(p).toContain('oops');
  });
});

describe('readExecutionOutput', () => {
  it('drains the async stream', async () => {
    const exec = {
      async *read() {
        yield 'a';
        yield 'b';
      },
    };
    await expect(readExecutionOutput(exec)).resolves.toBe('ab');
  });
});

describe('FailureTracker', () => {
  it('keeps only the latest 10 failures, newest first', () => {
    const t = new FailureTracker();
    for (let i = 0; i < 12; i++) t.record({ command: `cmd${i}`, exitCode: 1, output: '' });
    expect(t.size).toBe(10);
    expect(t.latest()?.command).toBe('cmd11');
  });
});

// -- wiring ------------------------------------------------------------------------------------

describe('registerTerminalExplain', () => {
  it('tracks failed shell executions and explains the latest', async () => {
    const { bridge } = setup();
    await shellListener()({
      exitCode: 1,
      execution: {
        commandLine: { value: 'npm test' },
        async *read() {
          yield 'some log\n';
          yield 'FAIL: boom\n';
        },
      },
    });
    await flush();

    await commandFn('sunday.terminal.explainError')();
    expect(bridge.chatSend).toHaveBeenCalledTimes(1);
    const sent = (bridge.chatSend.mock.calls[0] as unknown as Array<{ message: string }>)[0];
    expect(sent.message).toContain('npm test');
    expect(sent.message).toContain('Exit code: 1');
    expect(sent.message).toContain('FAIL: boom');
  });

  it('ignores successful executions', async () => {
    const { bridge } = setup();
    await shellListener()({ exitCode: 0, execution: { commandLine: { value: 'echo hi' }, async *read() {} } });
    await flush();
    mocks.showInputBox.mockResolvedValueOnce('pasted err');
    await commandFn('sunday.terminal.explainError')();
    const sent = (bridge.chatSend.mock.calls[0] as unknown as Array<{ message: string }>)[0];
    expect(sent.message).toContain('(pasted error output)');
    expect(sent.message).toContain('pasted err');
  });

  it('falls back to pasted input when nothing was tracked', async () => {
    const { bridge } = setup();
    mocks.showInputBox.mockResolvedValueOnce('  pasted error text  ');
    await commandFn('sunday.terminal.explainError')();
    expect(mocks.showInputBox).toHaveBeenCalled();
    const sent = (bridge.chatSend.mock.calls[0] as unknown as Array<{ message: string }>)[0];
    expect(sent.message).toContain('pasted error text');
  });

  it('does nothing when the paste prompt is cancelled', async () => {
    const { bridge } = setup();
    mocks.showInputBox.mockResolvedValueOnce(undefined);
    await commandFn('sunday.terminal.explainError')();
    expect(bridge.chatSend).not.toHaveBeenCalled();
  });
});
