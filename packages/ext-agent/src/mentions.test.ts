// Tests for @-mention parsing and expansion. `vscode` and `node:child_process`
// are mocked; no DOM, no network, no real VS Code.
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => p, scheme: 'file' }),
  },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  DiagnosticSeverity: ['Error', 'Warning', 'Information', 'Hint'],
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/ws', toString: () => '/ws' } }],
    fs: {
      readFile: vi.fn(),
      readDirectory: vi.fn(),
    },
    asRelativePath: (u: { fsPath: string }) => u.fsPath.replace(/^\/ws\//, ''),
  },
  window: {
    activeTextEditor: undefined as unknown,
    activeTerminal: undefined as unknown,
  },
  languages: { getDiagnostics: vi.fn() },
  commands: { executeCommand: vi.fn() },
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import {
  MAX_MENTION_CHARS,
  composeChatMessage,
  expandMentions,
  parseMentions,
  truncateMentionContent,
} from './mentions.js';

const enc = (s: string) => new TextEncoder().encode(s);
const mockFs = (vscode.workspace.fs as unknown as { readFile: any; readDirectory: any });

function setExecFile(statOut: string, diffOut: string) {
  (execFile as any).mockImplementation((_bin: string, args: string[], _opts: unknown, cb: any) => {
    if (args.includes('--stat')) cb(null, statOut, '');
    else cb(null, diffOut, '');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (vscode.window as any).activeTextEditor = undefined;
  (vscode.window as any).activeTerminal = undefined;
  (vscode.workspace.workspaceFolders as any) = [{ uri: { fsPath: '/ws' } }];
});

describe('parseMentions', () => {
  it('parses @file with a path argument', () => {
    const ms = parseMentions('look at @file src/index.ts please');
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'file', raw: '@file src/index.ts', arg: 'src/index.ts' });
    expect(ms[0]!.index).toBe('look at '.length);
  });

  it('parses bare kinds without arguments', () => {
    const ms = parseMentions('@selection and @terminal and @diagnostics and @git-diff');
    expect(ms.map((m) => m.kind)).toEqual(['selection', 'terminal', 'diagnostics', 'git-diff']);
    expect(ms.every((m) => m.arg === '')).toBe(true);
  });

  it('parses @web and @docs in bare and parenthesized forms', () => {
    const ms = parseMentions('@web https://example.com/x and @docs(foo) and @web(https://a.b)');
    expect(ms).toHaveLength(3);
    expect(ms[0]).toMatchObject({ kind: 'web', arg: 'https://example.com/x' });
    expect(ms[1]).toMatchObject({ kind: 'docs', arg: 'foo' });
    expect(ms[2]).toMatchObject({ kind: 'web', arg: 'https://a.b' });
  });

  it('parses quoted arguments containing spaces', () => {
    const ms = parseMentions('@file "my dir/a file.ts"');
    expect(ms).toHaveLength(1);
    expect(ms[0]!.arg).toBe('my dir/a file.ts');
  });

  it('ignores @ inside inline and fenced code spans', () => {
    const text = 'use `@file a.ts` not @file b.ts\n```\n@selection\n```\n@terminal';
    const ms = parseMentions(text);
    expect(ms.map((m) => m.kind)).toEqual(['file', 'terminal']);
    expect(ms[0]!.arg).toBe('b.ts');
  });

  it('does not let bare kinds swallow a following mention', () => {
    const ms = parseMentions('@selection then @file a.ts');
    expect(ms.map((m) => m.kind)).toEqual(['selection', 'file']);
    expect(ms[0]!.arg).toBe('');
    expect(ms[1]!.arg).toBe('a.ts');
  });

  it('does not match kinds glued to longer words', () => {
    expect(parseMentions('@filex')).toEqual([]);
    expect(parseMentions('@selection-foo')).toEqual([]);
  });

  it('ignores email addresses and unknown kinds', () => {
    const ms = parseMentions('mail user@example.com about @frobnicate and @unknown');
    expect(ms).toHaveLength(0);
  });

  it('returns no mentions for plain text', () => {
    expect(parseMentions('just a normal message')).toEqual([]);
  });
});

describe('truncateMentionContent', () => {
  it('returns short content unchanged', () => {
    expect(truncateMentionContent('@file a', 'short')).toBe('short');
  });

  it('truncates long content with a read-more handle', () => {
    const long = 'x'.repeat(MAX_MENTION_CHARS + 100);
    const out = truncateMentionContent('@file big.ts', long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('…[truncated — ask the agent to read more of @file big.ts]');
  });
});

describe('expandMentions', () => {
  it('expands @file with line numbers', async () => {
    mockFs.readFile.mockResolvedValue(enc('const a = 1;\nconst b = 2;\n'));
    const [b] = await expandMentions(parseMentions('see @file src/a.ts'));
    expect(b!.label).toBe('@file src/a.ts');
    expect(b!.content).toBe('1| const a = 1;\n2| const b = 2;');
    expect(mockFs.readFile.mock.calls[0][0].fsPath).toBe(path.join('/ws', 'src', 'a.ts'));
  });

  it('reports a missing file as a block instead of throwing', async () => {
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
    const [b] = await expandMentions(parseMentions('@file nope.ts'));
    expect(b!.content).toMatch(/Could not read nope\.ts/);
  });

  it('expands @folder as a sorted name listing with directory markers', async () => {
    mockFs.readDirectory.mockResolvedValue([
      ['b.ts', 1],
      ['a', 2],
    ]);
    const [b] = await expandMentions(parseMentions('@folder src'));
    expect(b!.content).toBe('a/\nb.ts');
  });

  it('expands @symbol via the workspace symbol provider', async () => {
    const exec = vscode.commands.executeCommand as any;
    exec.mockResolvedValue([
      {
        name: 'runTurn',
        location: {
          uri: { fsPath: '/ws/src/loop.ts' },
          range: { start: { line: 5 }, end: { line: 8 } },
        },
      },
    ]);
    mockFs.readFile.mockResolvedValue(enc(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')));
    const [b] = await expandMentions(parseMentions('@symbol runTurn'));
    expect(b!.label).toBe('@symbol runTurn');
    expect(b!.content).toContain('src/loop.ts:6');
    expect(b!.content).toContain('6| line 6');
    expect(exec).toHaveBeenCalledWith('vscode.executeWorkspaceSymbolProvider', 'runTurn');
  });

  it('expands @selection from the active editor', async () => {
    (vscode.window as any).activeTextEditor = {
      document: {
        uri: { fsPath: '/ws/src/a.ts' },
        getText: () => 'const x = 1;',
      },
      selection: {
        isEmpty: false,
        start: { line: 9 },
        end: { line: 9 },
      },
    };
    const [b] = await expandMentions(parseMentions('@selection'));
    expect(b!.content).toBe('src/a.ts:10-10\nconst x = 1;');
  });

  it('says so when there is no active selection', async () => {
    const [b] = await expandMentions(parseMentions('@selection'));
    expect(b!.content).toMatch(/No active selection/);
  });

  it('expands @terminal as metadata-only (no scrollback API exists)', async () => {
    (vscode.window as any).activeTerminal = {
      name: 'pwsh',
      processId: Promise.resolve(4242),
      creationOptions: { cwd: '/ws' },
    };
    const [b] = await expandMentions(parseMentions('@terminal'));
    expect(b!.content).toMatch(/Terminal: pwsh/);
    expect(b!.content).toMatch(/processId: 4242/);
    expect(b!.content).toMatch(/does not expose terminal output/);
  });

  it('expands @diagnostics as file:line:col [severity] message lines', async () => {
    (vscode.languages.getDiagnostics as any).mockReturnValue([
      [
        { fsPath: '/ws/src/a.ts' },
        [{ range: { start: { line: 2, character: 4 } }, severity: 0, message: 'oops' }],
      ],
    ]);
    const [b] = await expandMentions(parseMentions('@diagnostics'));
    expect(b!.content).toBe('src/a.ts:3:5 [Error] oops');
  });

  it('expands @git-diff with staged+unstaged diff via `git diff HEAD`', async () => {
    setExecFile(' a.ts | 2 +-\n', 'diff --git a/a.ts b/a.ts\n...');
    const [b] = await expandMentions(parseMentions('@git-diff'));
    expect(b!.label).toBe('@git-diff');
    expect(b!.content).toContain('diff --git');
    expect((execFile as any).mock.calls[0][1]).toContain('HEAD');
  });

  it('expands @web as a URL reference without fetching', async () => {
    const [b] = await expandMentions(parseMentions('@web https://example.com/x'));
    expect(b!.content).toContain('https://example.com/x');
    expect(b!.content).toMatch(/did not fetch/);
  });

  it('expands @docs from .sunday/skills by convention', async () => {
    mockFs.readFile.mockResolvedValue(
      enc('---\nname: foo\ndescription: Does foo things.\n---\n\n# Foo\nBody here.'),
    );
    const [b] = await expandMentions(parseMentions('@docs foo'));
    expect(b!.content).toContain('foo — Does foo things.');
    expect(b!.content).toContain('Body here.');
    expect(mockFs.readFile.mock.calls[0][0].fsPath).toBe(
      path.join('/ws', '.sunday', 'skills', 'foo', 'SKILL.md'),
    );
  });

  it('reports a missing skill instead of throwing', async () => {
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
    const [b] = await expandMentions(parseMentions('@docs nope'));
    expect(b!.content).toMatch(/not found/);
  });

  it('deduplicates repeated identical mentions', async () => {
    mockFs.readFile.mockResolvedValue(enc('x'));
    await expandMentions(parseMentions('@file a.ts and @file a.ts'));
    expect(mockFs.readFile).toHaveBeenCalledTimes(1);
  });

  it('truncates oversized expansions', async () => {
    mockFs.readFile.mockResolvedValue(enc('y'.repeat(MAX_MENTION_CHARS + 500)));
    const [b] = await expandMentions(parseMentions('@file big.ts'));
    expect(b!.content).toContain('…[truncated — ask the agent to read more of @file big.ts]');
  });
});

describe('composeChatMessage', () => {
  it('returns text-only parts when there are no mentions or images', async () => {
    const parts = await composeChatMessage('hello', []);
    expect(parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('omits the empty text part when only images are attached', async () => {
    const parts = await composeChatMessage('', [{ dataUrl: 'data:image/png;base64,AAA' }]);
    expect(parts).toEqual([{ type: 'image', dataUrl: 'data:image/png;base64,AAA' }]);
  });

  it('appends mention context as an extra text part and images as image parts', async () => {
    mockFs.readFile.mockResolvedValue(enc('const a = 1;'));
    const parts = await composeChatMessage('look @file a.ts', [
      { dataUrl: 'data:image/png;base64,AAA' },
    ]);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: 'look @file a.ts' });
    expect(parts[1]!.type).toBe('text');
    expect((parts[1] as { text: string }).text).toContain('--- context: @file a.ts ---');
    expect(parts[2]).toEqual({ type: 'image', dataUrl: 'data:image/png;base64,AAA' });
  });
});
