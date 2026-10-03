// Tests for next-edit suggestions (Phase 8, experimental).
// Pure prediction logic is tested directly; the tracker/provider wiring
// runs against a mocked `vscode` module. No DOM, no network, no real VS Code.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  config: { enabled: false } as Record<string, unknown>,
  capturedLensProviders: [] as Array<{ selector: unknown; provider: any }>,
  capturedCommands: new Map<string, (...args: any[]) => unknown>(),
  changeHandler: null as null | ((e: any) => void),
  openHandler: null as null | ((d: any) => void),
  closeHandler: null as null | ((d: any) => void),
  openTextDocument: vi.fn(),
  applyEdit: vi.fn(),
  textDocuments: [] as any[],
}));

vi.mock('vscode', () => {
  class Range {
    constructor(
      readonly startLine: number,
      readonly startChar: number,
      readonly endLine: number,
      readonly endChar: number,
    ) {}
  }
  class CodeLens {
    constructor(
      readonly range: unknown,
      readonly command?: unknown,
    ) {}
  }
  class EventEmitter {
    private listeners: Array<() => void> = [];
    event = (cb: () => void) => {
      this.listeners.push(cb);
      return { dispose: () => {} };
    };
    fire = () => {
      for (const l of this.listeners) l();
    };
    dispose = () => {};
  }
  class WorkspaceEdit {
    edits: unknown[] = [];
    replace(uri: unknown, range: unknown, newText: unknown) {
      this.edits.push({ uri, range, newText });
    }
  }
  return {
    workspace: {
      getConfiguration: (_section: string) => ({
        get: (key: string, dflt: unknown) =>
          key in hoisted.config ? hoisted.config[key] : dflt,
      }),
      onDidChangeTextDocument: (h: (e: any) => void) => {
        hoisted.changeHandler = h;
        return { dispose: () => {} };
      },
      onDidOpenTextDocument: (h: (d: any) => void) => {
        hoisted.openHandler = h;
        return { dispose: () => {} };
      },
      onDidCloseTextDocument: (h: (d: any) => void) => {
        hoisted.closeHandler = h;
        return { dispose: () => {} };
      },
      openTextDocument: (...args: unknown[]) => hoisted.openTextDocument(...args),
      applyEdit: (...args: unknown[]) => hoisted.applyEdit(...args),
      get textDocuments() {
        return hoisted.textDocuments;
      },
    },
    languages: {
      registerCodeLensProvider: (selector: unknown, provider: unknown) => {
        hoisted.capturedLensProviders.push({ selector, provider });
        return { dispose: () => {} };
      },
    },
    commands: {
      registerCommand: (id: string, handler: (...args: any[]) => unknown) => {
        hoisted.capturedCommands.set(id, handler);
        return { dispose: () => {} };
      },
    },
    Uri: { parse: (s: string) => ({ toString: () => s, scheme: 'file' }) },
    Range,
    CodeLens,
    EventEmitter,
    WorkspaceEdit,
  };
});

import {
  detectRename,
  escapeRegExp,
  findNextOccurrence,
  NextEditCodeLensProvider,
  NextEditTracker,
  offsetToPosition,
  predictNextEdit,
  readNextEditConfig,
  registerNextEdit,
} from './nextEdit.js';

beforeEach(() => {
  hoisted.config = { enabled: false };
  hoisted.capturedLensProviders.length = 0;
  hoisted.capturedCommands.clear();
  hoisted.changeHandler = null;
  hoisted.openHandler = null;
  hoisted.closeHandler = null;
  hoisted.openTextDocument.mockReset();
  hoisted.applyEdit.mockReset();
  hoisted.textDocuments = [];
});

function makeContext() {
  return { subscriptions: [] as Array<{ dispose(): void }> } as any;
}

function makeDoc(uri: string, version: number, text: string) {
  return {
    uri: { toString: () => uri },
    version,
    getText: () => text,
  };
}

function fireChange(doc: any, changes: any[]) {
  if (!hoisted.changeHandler) throw new Error('change handler not registered');
  hoisted.changeHandler({ document: doc, contentChanges: changes });
}

describe('detectRename', () => {
  it('detects a clean identifier swap', () => {
    expect(detectRename('foo', 'bar')).toEqual({ oldName: 'foo', newName: 'bar' });
  });
  it('rejects identical text', () => {
    expect(detectRename('foo', 'foo')).toBeNull();
  });
  it('rejects non-identifiers', () => {
    expect(detectRename('foo', 'not an ident')).toBeNull();
    expect(detectRename('foo bar', 'baz')).toBeNull();
    expect(detectRename('123', 'bar')).toBeNull();
    expect(detectRename('', 'bar')).toBeNull();
  });
  it('rejects single-letter identifiers as too noisy', () => {
    expect(detectRename('i', 'index')).toBeNull();
  });
  it('accepts $ and _ identifier chars', () => {
    expect(detectRename('$old', '_new')).toEqual({ oldName: '$old', newName: '_new' });
  });
});

describe('escapeRegExp / offsetToPosition / findNextOccurrence', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b$c')).toBe('a\\.b\\$c');
  });
  it('converts offsets to line/character', () => {
    expect(offsetToPosition('a\nbc', 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition('a\nbc', 3)).toEqual({ line: 1, character: 1 });
    expect(offsetToPosition('a\nbc', 99)).toEqual({ line: 1, character: 2 });
  });
  it('finds the next occurrence after the offset', () => {
    expect(findNextOccurrence('foo bar foo', 'foo', 4)).toBe(8);
  });
  it('wraps to the start when nothing follows', () => {
    expect(findNextOccurrence('foo bar', 'foo', 4)).toBe(0);
  });
  it('returns null when the name is absent', () => {
    expect(findNextOccurrence('bar baz', 'foo', 0)).toBeNull();
  });
  it('respects word boundaries', () => {
    // 'foo' inside 'foobar' must not match.
    expect(findNextOccurrence('foobar foo', 'foo', 0)).toBe(7);
  });
  it('handles regex metacharacters in the name', () => {
    expect(findNextOccurrence('a$b a$b', 'a$b', 4)).toBe(4);
  });
});

describe('predictNextEdit', () => {
  const before = 'const foo = 1;\nconsole.log(foo);';
  const after = 'const bar = 1;\nconsole.log(foo);';
  // 'foo' at offset 6..9 replaced by 'bar'.
  const base = {
    beforeText: before,
    afterText: after,
    changeOffset: 6,
    changeLength: 3,
    changeText: 'bar',
    uri: 'file:///a.ts',
    version: 5,
  };
  it('predicts the next occurrence of the renamed identifier', () => {
    const s = predictNextEdit(base);
    expect(s).not.toBeNull();
    expect(s!.oldText).toBe('foo');
    expect(s!.newText).toBe('bar');
    // 'foo' in 'console.log(foo);' starts at line 1, char 12.
    expect(s!.range.start).toEqual({ line: 1, character: 12 });
    expect(s!.range.end).toEqual({ line: 1, character: 15 });
    expect(s!.uri).toBe('file:///a.ts');
    expect(s!.version).toBe(5);
  });
  it('returns null when no occurrences remain', () => {
    const s = predictNextEdit({
      ...base,
      afterText: 'const bar = 1;\nconsole.log(bar);',
    });
    expect(s).toBeNull();
  });
  it('returns null for non-rename edits', () => {
    const s = predictNextEdit({ ...base, changeText: 'bar + 1' });
    expect(s).toBeNull();
  });
});

describe('readNextEditConfig', () => {
  it('defaults to disabled', () => {
    expect(readNextEditConfig()).toEqual({ enabled: false });
  });
  it('reads the enabled flag', () => {
    hoisted.config = { enabled: true };
    expect(readNextEditConfig()).toEqual({ enabled: true });
  });
});

describe('NextEditTracker + provider wiring', () => {
  function setupTracker() {
    const ctx = makeContext();
    const provider = new NextEditCodeLensProvider();
    const tracker = new NextEditTracker(provider);
    tracker.start(ctx);
    return { ctx, provider };
  }

  it('produces no lens when disabled', () => {
    const { provider } = setupTracker();
    const doc = makeDoc('file:///a.ts', 2, 'const bar = 1;\nconsole.log(foo);');
    hoisted.openHandler!(doc);
    fireChange(doc, [{ rangeOffset: 6, rangeLength: 3, text: 'bar' }]);
    // Simulate the pre-change snapshot path: open first with old text.
    expect(provider.provideCodeLenses(doc as any)).toEqual([]);
  });

  it('offers a lens after a rename-like change when enabled', () => {
    hoisted.config = { enabled: true };
    const { provider } = setupTracker();
    // Open with the old text so the tracker snapshots beforeText.
    hoisted.openHandler!(makeDoc('file:///a.ts', 1, 'const foo = 1;\nconsole.log(foo);'));
    const doc = makeDoc('file:///a.ts', 2, 'const bar = 1;\nconsole.log(foo);');
    fireChange(doc, [{ rangeOffset: 6, rangeLength: 3, text: 'bar' }]);
    const lenses = provider.provideCodeLenses(doc as any);
    expect(lenses).toHaveLength(1);
    const cmd = (lenses[0] as any).command;
    expect(cmd.command).toBe('sunday.nextEdit.apply');
    expect(cmd.title).toContain('foo');
    expect(cmd.title).toContain('bar');
    expect(cmd.arguments).toEqual(['file:///a.ts']);
  });

  it('clears the lens when the document changes again', () => {
    hoisted.config = { enabled: true };
    const { provider } = setupTracker();
    hoisted.openHandler!(makeDoc('file:///a.ts', 1, 'const foo = 1;\nconsole.log(foo);'));
    const doc2 = makeDoc('file:///a.ts', 2, 'const bar = 1;\nconsole.log(foo);');
    fireChange(doc2, [{ rangeOffset: 6, rangeLength: 3, text: 'bar' }]);
    expect(provider.provideCodeLenses(doc2 as any)).toHaveLength(1);
    // An unrelated edit clears the pending suggestion.
    const doc3 = makeDoc('file:///a.ts', 3, 'const bar = 1;\nconsole.log(foo); // x');
    fireChange(doc3, [{ rangeOffset: 31, rangeLength: 0, text: ' // x' }]);
    expect(provider.provideCodeLenses(doc3 as any)).toEqual([]);
  });

  it('ignores multi-change events but keeps tracking', () => {
    hoisted.config = { enabled: true };
    const { provider } = setupTracker();
    hoisted.openHandler!(makeDoc('file:///a.ts', 1, 'const foo = 1;'));
    const doc = makeDoc('file:///a.ts', 2, 'const bar = 2;');
    fireChange(doc, [
      { rangeOffset: 6, rangeLength: 3, text: 'bar' },
      { rangeOffset: 14, rangeLength: 1, text: '2' },
    ]);
    expect(provider.provideCodeLenses(doc as any)).toEqual([]);
  });

  it('hides the lens when the document version moved on', () => {
    hoisted.config = { enabled: true };
    const { provider } = setupTracker();
    hoisted.openHandler!(makeDoc('file:///a.ts', 1, 'const foo = 1;\nconsole.log(foo);'));
    const doc2 = makeDoc('file:///a.ts', 2, 'const bar = 1;\nconsole.log(foo);');
    fireChange(doc2, [{ rangeOffset: 6, rangeLength: 3, text: 'bar' }]);
    const staleDoc = makeDoc('file:///a.ts', 99, 'const bar = 1;\nconsole.log(foo);');
    expect(provider.provideCodeLenses(staleDoc as any)).toEqual([]);
  });
});

describe('registerNextEdit', () => {
  it('registers the lens provider and the apply command', () => {
    const ctx = makeContext();
    registerNextEdit(ctx);
    expect(hoisted.capturedLensProviders).toHaveLength(1);
    expect(hoisted.capturedCommands.has('sunday.nextEdit.apply')).toBe(true);
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  it('apply command is a no-op without a pending suggestion', async () => {
    hoisted.config = { enabled: true };
    registerNextEdit(makeContext());
    const handler = hoisted.capturedCommands.get('sunday.nextEdit.apply')!;
    await handler('file:///missing.ts');
    expect(hoisted.applyEdit).not.toHaveBeenCalled();
  });

  it('apply command applies the suggested edit for the matching version', async () => {
    hoisted.config = { enabled: true };
    registerNextEdit(makeContext());
    hoisted.openHandler!(makeDoc('file:///a.ts', 1, 'const foo = 1;\nconsole.log(foo);'));
    const doc2 = makeDoc('file:///a.ts', 2, 'const bar = 1;\nconsole.log(foo);');
    hoisted.changeHandler!({ document: doc2, contentChanges: [{ rangeOffset: 6, rangeLength: 3, text: 'bar' }] });
    hoisted.openTextDocument.mockResolvedValue(doc2);
    hoisted.applyEdit.mockResolvedValue(true);
    const handler = hoisted.capturedCommands.get('sunday.nextEdit.apply')!;
    await handler('file:///a.ts');
    expect(hoisted.applyEdit).toHaveBeenCalledTimes(1);
    const edit = hoisted.applyEdit.mock.calls[0][0] as any;
    expect(edit.edits).toHaveLength(1);
    expect(edit.edits[0].newText).toBe('bar');
  });

  it('apply command refuses a stale version', async () => {
    hoisted.config = { enabled: true };
    registerNextEdit(makeContext());
    hoisted.openHandler!(makeDoc('file:///a.ts', 1, 'const foo = 1;\nconsole.log(foo);'));
    const doc2 = makeDoc('file:///a.ts', 2, 'const bar = 1;\nconsole.log(foo);');
    hoisted.changeHandler!({ document: doc2, contentChanges: [{ rangeOffset: 6, rangeLength: 3, text: 'bar' }] });
    // Document has moved on past the suggestion's version.
    hoisted.openTextDocument.mockResolvedValue(makeDoc('file:///a.ts', 3, 'const bar = 1;\nconsole.log(foo);'));
    const handler = hoisted.capturedCommands.get('sunday.nextEdit.apply')!;
    await handler('file:///a.ts');
    expect(hoisted.applyEdit).not.toHaveBeenCalled();
  });
});
