// Tests for inlineEdit.ts: prompt builder, fence stripping, range computation,
// accept/reject flow against a mocked `vscode` module, and chat/send payload
// shape. No DOM, no network, no real VS Code.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vsState = vi.hoisted(() => ({
  editor: null as any,
  inputBoxResult: 'make it async' as string | undefined,
  messageChoice: 'Accept' as string | undefined,
  executedCommands: [] as any[][],
  openedContents: [] as string[],
  infoMessages: [] as string[],
  errorMessages: [] as string[],
  shownInputBoxOpts: null as any,
}));

vi.mock('vscode', () => ({
  Range: class {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number,
    ) {}
  },
  Selection: class {},
  ProgressLocation: { Notification: 15 },
  window: {
    get activeTextEditor() {
      return vsState.editor;
    },
    showInputBox: vi.fn(async (opts: any) => {
      vsState.shownInputBoxOpts = opts;
      return vsState.inputBoxResult;
    }),
    showInformationMessage: vi.fn(async (...args: any[]) => {
      vsState.infoMessages.push(String(args[0]));
      return vsState.messageChoice;
    }),
    showErrorMessage: vi.fn(async (...args: any[]) => {
      vsState.errorMessages.push(String(args[0]));
      return undefined;
    }),
    withProgress: vi.fn(async (_opts: any, task: any) =>
      task(
        { report: () => undefined },
        { onCancellationRequested: () => ({ dispose: () => undefined }) },
      ),
    ),
  },
  workspace: {
    openTextDocument: vi.fn(async (opts: any) => {
      vsState.openedContents.push(opts.content);
      return {
        uri: { toString: () => 'untitled:temp' },
        languageId: opts.language,
        getText: () => opts.content,
      };
    }),
  },
  commands: {
    executeCommand: vi.fn(async (...args: any[]) => {
      vsState.executedCommands.push(args);
      return undefined;
    }),
    registerCommand: vi.fn((_id: string, _fn: any) => ({ dispose: () => undefined })),
  },
}));

import {
  applyReplacement,
  buildEditPrompt,
  computeTargetRange,
  extractRewrittenCode,
  registerInlineEdit,
  runInlineEdit,
} from './inlineEdit.js';
import type { HostBridge } from './hostBridge.js';

const flush = () => new Promise((r) => setTimeout(r, 20));

type MockBridge = ReturnType<typeof makeBridge>;
const asBridge = (b: MockBridge): HostBridge => b as unknown as HostBridge;

/** Bridge that streams `replyText` as one text-delta, then turn-end. */
function makeBridge(replyText: string, opts: { fail?: { code: number; message: string } } = {}) {
  const listeners = new Set<(n: any) => void>();
  let lastParams: any = undefined;
  const bridge = {
    listeners,
    get lastParams() {
      return lastParams;
    },
    sessionCreate: vi.fn(async (_p: any) => ({
      session: { id: 'sess-edit', title: '', createdAt: '', updatedAt: '' },
    })),
    chatSend: vi.fn(async (p: any) => {
      lastParams = p;
      setTimeout(() => {
        for (const l of [...listeners]) {
          if (opts.fail) {
            l({
              turnId: 'turn-e1',
              sessionId: 'sess-edit',
              event: { type: 'turn-error', code: opts.fail.code, message: opts.fail.message },
            });
          } else {
            l({
              turnId: 'turn-e1',
              sessionId: 'sess-edit',
              event: { type: 'text-delta', delta: replyText },
            });
            l({
              turnId: 'turn-e1',
              sessionId: 'sess-edit',
              event: { type: 'turn-end', finishReason: 'stop' },
            });
          }
        }
      }, 0);
      return { turnId: 'turn-e1' };
    }),
    cancelActiveTurn: vi.fn(async () => true),
    onChatEvent: vi.fn((l: (n: any) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
  };
  return bridge;
}

function makeEditor(text: string, selection: any) {
  const replacements: Array<[any, string]> = [];
  return {
    replacements,
    document: {
      uri: { toString: () => 'file:///proj/a.ts' },
      languageId: 'typescript',
      lineCount: text.split('\n').length,
      getText: vi.fn((_range?: any) => text),
    },
    selection,
    edit: vi.fn(async (cb: any) => {
      cb({ replace: (r: any, t: string) => replacements.push([r, t]) });
      return true;
    }),
  };
}

function makeDeps(bridge: MockBridge | undefined) {
  return {
    getBridge: () => (bridge ? asBridge(bridge) : undefined),
    ensureBridge: vi.fn(async () => (bridge ? asBridge(bridge) : undefined)),
    log: vi.fn(),
  };
}

beforeEach(() => {
  vsState.editor = null;
  vsState.inputBoxResult = 'make it async';
  vsState.messageChoice = 'Accept';
  vsState.executedCommands = [];
  vsState.openedContents = [];
  vsState.infoMessages = [];
  vsState.errorMessages = [];
  vsState.shownInputBoxOpts = null;
  vi.clearAllMocks();
});

describe('buildEditPrompt', () => {
  it('includes the instruction, the code, and the language', () => {
    const p = buildEditPrompt('use const', 'let x = 1;', 'typescript');
    expect(p).toContain('use const');
    expect(p).toContain('let x = 1;');
    expect(p).toContain('typescript');
    expect(p).toContain('FULL rewritten code block');
    expect(p).not.toContain('AURORA');
  });
});

describe('extractRewrittenCode', () => {
  it('strips a fenced block with a language tag', () => {
    expect(extractRewrittenCode('```typescript\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('strips a fenced block without a language tag', () => {
    expect(extractRewrittenCode('```\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('takes the first fenced block when prose surrounds it', () => {
    const reply = 'Here is the rewrite:\n```ts\nconst x = 1;\n```\nHope that helps.';
    expect(extractRewrittenCode(reply)).toBe('const x = 1;');
  });

  it('passes plain text through, trimmed', () => {
    expect(extractRewrittenCode('  const x = 1;\n')).toBe('const x = 1;');
  });
});

describe('computeTargetRange', () => {
  it('returns the selection when it is not empty', () => {
    const sel = { isEmpty: false, start: { line: 1 }, end: { line: 2 } };
    const doc = { lineCount: 10 } as any;
    expect(computeTargetRange(doc, sel as any)).toBe(sel);
  });

  it('returns the whole document when the selection is empty', () => {
    const doc = { lineCount: 7 } as any;
    const range = computeTargetRange(doc, { isEmpty: true } as any) as any;
    expect(range.startLine).toBe(0);
    expect(range.endLine).toBe(7);
  });
});

describe('applyReplacement', () => {
  it('replaces the range via the edit builder', async () => {
    const editor = makeEditor('old', { isEmpty: false });
    const range = { startLine: 0, endLine: 1 } as any;
    const ok = await applyReplacement(editor as any, range, 'new');
    expect(ok).toBe(true);
    expect(editor.replacements).toHaveLength(1);
    expect(editor.replacements[0][0]).toBe(range);
    expect(editor.replacements[0][1]).toBe('new');
  });
});

describe('runInlineEdit — accept path', () => {
  it('sends chat/send with the built prompt, opens a diff, and applies on Accept', async () => {
    const original = 'function f() { return 1; }';
    const rewritten = 'function f() { return 2; }';
    const sel = { isEmpty: false, startLine: 0, startChar: 0, endLine: 0, endChar: 10 };
    const editor = makeEditor(original, sel);
    vsState.editor = editor;
    const bridge = makeBridge(`\`\`\`typescript\n${rewritten}\n\`\`\``);
    const deps = makeDeps(bridge);

    await runInlineEdit(deps);
    await flush();

    // RPC payload shape: edit-scoped session + the constrained prompt as message.
    expect(bridge.chatSend).toHaveBeenCalledTimes(1);
    const params = bridge.lastParams;
    expect(params.sessionId).toBe('sess-edit');
    expect(typeof params.message).toBe('string');
    expect(params.message).toContain('make it async');
    expect(params.message).toContain(original);
    expect(params.message).toContain('typescript');

    // Review surface: temp doc carries the rewritten code; vscode.diff opened.
    expect(vsState.openedContents).toEqual([rewritten]);
    const diffCall = vsState.executedCommands.find((c) => c[0] === 'vscode.diff');
    expect(diffCall).toBeDefined();
    expect(diffCall![1].toString()).toBe('file:///proj/a.ts');
    expect(diffCall![2].toString()).toBe('untitled:temp');

    // Accept → edit applied over the original selection range.
    expect(editor.edit).toHaveBeenCalledTimes(1);
    expect(editor.replacements[0][0]).toBe(sel);
    expect(editor.replacements[0][1]).toBe(rewritten);
    expect(vsState.infoMessages).toContain('Sunday: edit applied.');
  });
});

describe('runInlineEdit — reject path', () => {
  it('does not apply the edit when the user rejects', async () => {
    vsState.messageChoice = 'Reject';
    const editor = makeEditor('const a = 1;', { isEmpty: false });
    vsState.editor = editor;
    const bridge = makeBridge('const a = 2;');
    const deps = makeDeps(bridge);

    await runInlineEdit(deps);
    await flush();

    expect(bridge.chatSend).toHaveBeenCalledTimes(1);
    expect(vsState.executedCommands.some((c) => c[0] === 'vscode.diff')).toBe(true);
    expect(editor.edit).not.toHaveBeenCalled();
    expect(vsState.infoMessages).toContain('Sunday: edit discarded.');
    expect(vsState.executedCommands.some((c) => c[0] === 'workbench.action.closeActiveEditor')).toBe(
      true,
    );
  });
});

describe('runInlineEdit — edge cases', () => {
  it('uses the whole document when the selection is empty', async () => {
    const text = 'line1\nline2';
    const editor = makeEditor(text, { isEmpty: true });
    vsState.editor = editor;
    const bridge = makeBridge('changed');
    await runInlineEdit(makeDeps(bridge));
    await flush();

    const getTextArg = editor.document.getText.mock.calls[0][0];
    expect(getTextArg.startLine).toBe(0);
    expect(getTextArg.endLine).toBe(2);
    expect(editor.edit).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the instruction box is cancelled', async () => {
    vsState.inputBoxResult = undefined;
    vsState.editor = makeEditor('x', { isEmpty: false });
    const bridge = makeBridge('y');
    await runInlineEdit(makeDeps(bridge));
    await flush();
    expect(bridge.chatSend).not.toHaveBeenCalled();
    expect(vsState.executedCommands).toHaveLength(0);
  });

  it('shows an error and opens no diff when the turn fails', async () => {
    vsState.editor = makeEditor('x', { isEmpty: false });
    const bridge = makeBridge('', { fail: { code: 500, message: 'boom' } });
    await runInlineEdit(makeDeps(bridge));
    await flush();
    expect(vsState.errorMessages.some((m) => m.includes('boom'))).toBe(true);
    expect(vsState.executedCommands.some((c) => c[0] === 'vscode.diff')).toBe(false);
  });

  it('skips the diff when the agent proposes no changes', async () => {
    const original = 'const a = 1;';
    vsState.editor = makeEditor(original, { isEmpty: false });
    const bridge = makeBridge(original);
    const editor = vsState.editor;
    await runInlineEdit(makeDeps(bridge));
    await flush();
    expect(vsState.infoMessages).toContain(
      'Sunday Inline Edit: the agent proposed no changes.',
    );
    expect(editor.edit).not.toHaveBeenCalled();
  });
});

describe('registerInlineEdit', () => {
  it('registers the sunday.inlineEdit command', async () => {
    const context = { subscriptions: [] as any[] };
    const vscodeNs = (await import('vscode')) as any;
    registerInlineEdit(context as any, makeDeps(undefined) as any);
    expect(vscodeNs.commands.registerCommand).toHaveBeenCalledWith(
      'sunday.inlineEdit',
      expect.any(Function),
    );
    expect(context.subscriptions).toHaveLength(1);
  });
});
