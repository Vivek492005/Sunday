// Tests for the code-actions feature: pure prompt builders, the enclosing
// block heuristic, the provider's action set, and the registered command
// handlers. `vscode` is mocked with the same vi.mock pattern as
// chatView.test.ts. No DOM, no network, no real VS Code.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerCodeActionsProvider: vi.fn(() => ({ dispose: () => undefined })),
  registerCommand: vi.fn((_id: string, _fn: (...a: unknown[]) => unknown) => ({ dispose: () => undefined })),
  executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
  showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('vscode', () => ({
  CodeAction: class {
    title: string;
    kind: unknown;
    command: unknown;
    diagnostics: unknown[] = [];
    constructor(title: string, kind?: unknown) {
      this.title = title;
      this.kind = kind;
    }
  },
  CodeActionKind: { QuickFix: 'quickfix', Empty: '' },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
    0: 'Error',
    1: 'Warning',
    2: 'Information',
    3: 'Hint',
  },
  languages: { registerCodeActionsProvider: mocks.registerCodeActionsProvider },
  commands: { registerCommand: mocks.registerCommand, executeCommand: mocks.executeCommand },
  window: { showErrorMessage: mocks.showErrorMessage },
}));

import * as vscode from 'vscode';
import {
  SundayCodeActionProvider,
  buildExplainPrompt,
  buildFixPrompt,
  buildTestsPrompt,
  extractRelevantCode,
  findEnclosingBlock,
  registerCodeActions,
  summarizeDiagnostics,
  truncateCode,
} from './codeActions.js';
import { AgentSender } from './agentSend.js';
import type { HostBridge } from './hostBridge.js';

// -- fake document ---------------------------------------------------------------

function makeDoc(text: string, languageId = 'typescript', fileName = '/ws/src/a.ts') {
  const lineStarts: number[] = [];
  let i = 0;
  for (const line of text.split('\n')) {
    lineStarts.push(i);
    i += line.length + 1;
  }
  return {
    fileName,
    languageId,
    getText: () => text,
    offsetAt: (p: { line: number; character: number }) => lineStarts[p.line] + p.character,
  };
}

const pos = (line: number, character: number) => ({ line, character });

function makeBridge() {
  return {
    sessionCreate: vi.fn(async () => ({ session: { id: 'sess-1' } })),
    chatSend: vi.fn(async () => ({ turnId: 'turn-1' })),
    onChatEvent: vi.fn(() => () => undefined),
  };
}
const asBridge = (b: ReturnType<typeof makeBridge>): HostBridge => b as unknown as HostBridge;

function registeredCommands(): Map<string, (...a: unknown[]) => Promise<unknown>> {
  const m = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  for (const [id, fn] of mocks.registerCommand.mock.calls) m.set(id as string, fn as (...a: unknown[]) => Promise<unknown>);
  return m;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// -- prompt builders --------------------------------------------------------------

describe('buildFixPrompt', () => {
  it('lists diagnostics with severity, line and code', () => {
    const p = buildFixPrompt(
      [
        { message: "Cannot find name 'foo'.", severity: 'Error', line: 12, code: '2304' },
        { message: 'Unused var.', severity: 'Warning', line: 3 },
      ],
      'const x = foo();',
      { filePath: '/ws/src/a.ts', languageId: 'typescript' },
    );
    expect(p).toContain("- [Error] line 12 (2304): Cannot find name 'foo'.");
    expect(p).toContain('- [Warning] line 3: Unused var.');
    expect(p).toContain('in /ws/src/a.ts');
    expect(p).toContain('```typescript');
    expect(p).toContain('const x = foo();');
  });
});

describe('buildExplainPrompt', () => {
  it('embeds code in a language fence', () => {
    const p = buildExplainPrompt('def f(): pass', 'python');
    expect(p).toContain('```python');
    expect(p).toContain('def f(): pass');
    expect(p).toContain('Explain');
  });
});

describe('buildTestsPrompt', () => {
  it('asks for vitest tests', () => {
    const p = buildTestsPrompt('export const add = (a,b) => a+b;', 'typescript');
    expect(p).toContain('vitest');
    expect(p).toContain('export const add');
  });
});

describe('truncateCode', () => {
  it('leaves short code alone and marks truncation', () => {
    expect(truncateCode('abc', 10)).toBe('abc');
    const t = truncateCode('x'.repeat(100), 10);
    expect(t.length).toBeLessThan(100);
    expect(t).toContain('truncated');
  });
});

// -- enclosing block ---------------------------------------------------------------

describe('findEnclosingBlock', () => {
  const text = 'const a = 1;\nfunction f() {\n  const x = { y: 2 };\n  return x;\n}\nconst b = 2;\n';
  it('finds the innermost block around the cursor', () => {
    const off = text.indexOf('y: 2');
    const span = findEnclosingBlock(text, off);
    expect(span).toBeDefined();
    expect(text.slice(span!.start, span!.end)).toBe('{ y: 2 }');
  });
  it('returns undefined outside any block', () => {
    expect(findEnclosingBlock(text, text.indexOf('const a'))).toBeUndefined();
  });
  it('ignores braces inside strings and comments', () => {
    const t = 'const s = "{ not a block }"; // }\nfunction g() {\n  return 1;\n}\n';
    const span = findEnclosingBlock(t, t.indexOf('return 1'));
    expect(span).toBeDefined();
    expect(t.slice(span!.start, span!.end)).toContain('return 1');
  });
});

describe('extractRelevantCode', () => {
  it('prefers an explicit selection', () => {
    expect(extractRelevantCode('aaa\nbbb\nccc', 0, 3)).toBe('aaa');
  });
  it('falls back to the enclosing block for an empty selection', () => {
    const t = 'function f() {\n  return 1;\n}\n';
    expect(extractRelevantCode(t, t.indexOf('return'))).toContain('function f()');
  });
  it('falls back to the cursor line when there is no block', () => {
    const t = 'line one\nline two\n';
    expect(extractRelevantCode(t, 2)).toBe('line one');
  });
});

// -- provider -----------------------------------------------------------------------

describe('SundayCodeActionProvider', () => {
  const sender = () =>
    new AgentSender({ ensureBridge: async () => { throw new Error('no bridge'); }, getCwd: () => '/ws', log: () => undefined });

  it('offers Fix (QuickFix) when diagnostics exist, with summaries + code', () => {
    const text = 'function f() {\n  return foo;\n}\n';
    const doc = makeDoc(text);
    const diag = {
      message: "Cannot find name 'foo'.",
      severity: 0,
      range: { start: pos(1, 9), end: pos(1, 12) },
      code: '2304',
    } as unknown as vscode.Diagnostic;
    const provider = new SundayCodeActionProvider(sender());
    const actions = provider.provideCodeActions(
      doc as unknown as vscode.TextDocument,
      { start: pos(1, 9), end: pos(1, 9) } as unknown as vscode.Range,
      { diagnostics: [diag] } as unknown as vscode.CodeActionContext,
    );
    const fix = actions.find((a) => a.title === 'Fix with Sunday');
    expect(fix).toBeDefined();
    expect(fix!.kind).toBe('quickfix');
    const args = (fix!.command as { arguments: unknown[] }).arguments as unknown[];
    expect(args[0]).toEqual([
      { message: "Cannot find name 'foo'.", severity: 'Error', line: 2, code: '2304' },
    ]);
    expect(args[1] as string).toContain('function f()');
    expect(args[2]).toBe('/ws/src/a.ts');
    expect(actions.some((a) => a.title === 'Explain with Sunday')).toBe(true);
    expect(actions.some((a) => a.title === 'Generate tests with Sunday')).toBe(true);
  });

  it('omits Fix when there are no diagnostics', () => {
    const doc = makeDoc('const x = 1;\n');
    const provider = new SundayCodeActionProvider(sender());
    const actions = provider.provideCodeActions(
      doc as unknown as vscode.TextDocument,
      { start: pos(0, 0), end: pos(0, 0) } as unknown as vscode.Range,
      { diagnostics: [] } as unknown as vscode.CodeActionContext,
    );
    expect(actions.find((a) => a.title === 'Fix with Sunday')).toBeUndefined();
    expect(actions).toHaveLength(2);
  });

  it('sends the explicit selection for explain/tests', () => {
    const doc = makeDoc('aaa\nbbb\nccc\n');
    const provider = new SundayCodeActionProvider(sender());
    const actions = provider.provideCodeActions(
      doc as unknown as vscode.TextDocument,
      { start: pos(1, 0), end: pos(1, 3) } as unknown as vscode.Range,
      { diagnostics: [] } as unknown as vscode.CodeActionContext,
    );
    const explain = actions.find((a) => a.title === 'Explain with Sunday')!;
    expect((explain.command as { arguments: unknown[] }).arguments[0]).toBe('bbb');
  });

  it('offers no actions for blank code', () => {
    const doc = makeDoc('   \n');
    const provider = new SundayCodeActionProvider(sender());
    const actions = provider.provideCodeActions(
      doc as unknown as vscode.TextDocument,
      { start: pos(0, 1), end: pos(0, 1) } as unknown as vscode.Range,
      { diagnostics: [] } as unknown as vscode.CodeActionContext,
    );
    expect(actions).toHaveLength(0);
  });
});

// -- registration --------------------------------------------------------------------

describe('registerCodeActions', () => {
  it('registers the provider and the three commands; explain sends + focuses chat', async () => {
    const bridge = makeBridge();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    registerCodeActions(context, {
      ensureBridge: async () => asBridge(bridge),
      getCwd: () => '/ws',
      log: () => undefined,
    });
    expect(mocks.registerCodeActionsProvider).toHaveBeenCalled();
    const cmds = registeredCommands();
    expect([...cmds.keys()].sort()).toEqual([
      'sunday.codeAction.explain',
      'sunday.codeAction.fix',
      'sunday.codeAction.generateTests',
    ]);

    await cmds.get('sunday.codeAction.explain')!('const x = 1;', 'typescript');
    expect(bridge.chatSend).toHaveBeenCalledTimes(1);
    const sent = (bridge.chatSend.mock.calls[0] as unknown as Array<{ message: string }>)[0];
    expect(sent.message).toContain('Explain');
    expect(sent.message).toContain('const x = 1;');
    expect(mocks.executeCommand).toHaveBeenCalledWith('sunday.chat.focus');
  });

  it('reports failures instead of throwing', async () => {
    const bridge = makeBridge();
    bridge.chatSend = vi.fn(async () => {
      throw new Error('sidecar down');
    });
    registerCodeActions({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      ensureBridge: async () => asBridge(bridge),
      getCwd: () => '/ws',
      log: () => undefined,
    });
    await registeredCommands().get('sunday.codeAction.generateTests')!('code', 'typescript');
    expect(mocks.showErrorMessage).toHaveBeenCalled();
  });
});
