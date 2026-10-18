import { afterEach, describe, expect, it } from 'vitest';
import {
  fuzzyFilter,
  getCommands,
  registerCommand,
  unregisterCommand,
  type SundayCommand,
} from './commands';

const mk = (id: string, title: string, hint?: string): SundayCommand => ({
  id,
  title,
  hint,
  run: () => undefined,
});

describe('fuzzyFilter', () => {
  const commands: SundayCommand[] = [
    mk('open-folder', 'Open Folder', 'Ctrl+O'),
    mk('save', 'Save', 'Ctrl+S'),
    mk('toggle-sidebar', 'Toggle Sidebar', 'Ctrl+B'),
    mk('auto-save', 'Auto Save As'),
    mk('close-window', 'Close Window'),
    mk('new-file', 'New File', 'Ctrl+N'),
    mk('absorb', 'Absorb'),
  ];

  it('returns everything in registration order for an empty/blank query', () => {
    expect(fuzzyFilter('', commands).map((c) => c.id)).toEqual(commands.map((c) => c.id));
    expect(fuzzyFilter('   ', commands).map((c) => c.id)).toEqual(commands.map((c) => c.id));
  });

  it('matches case-insensitively', () => {
    const ids = fuzzyFilter('OPEN', commands).map((c) => c.id);
    expect(ids).toContain('open-folder');
  });

  it('matches subsequences, not just prefixes', () => {
    const ids = fuzzyFilter('tsb', commands).map((c) => c.id);
    expect(ids).toContain('toggle-sidebar');
  });

  it('ranks a title prefix above a mid-title word-boundary match', () => {
    // "sav": "Save" starts with it, "Auto Save As" only matches at a word boundary.
    const ids = fuzzyFilter('sav', commands).map((c) => c.id);
    expect(ids).toEqual(['save', 'auto-save']);
  });

  it('ranks word-boundary matches above scattered matches', () => {
    // "sb": "Toggle Sidebar" matches 's' at a word boundary ("Sidebar");
    // "Absorb" only matches the same letters scattered inside a word.
    const ids = fuzzyFilter('sb', commands).map((c) => c.id);
    expect(ids[0]).toBe('toggle-sidebar');
    expect(ids).toContain('absorb');
  });

  it('excludes commands that do not contain the query', () => {
    expect(fuzzyFilter('zzz', commands)).toEqual([]);
  });

  it('requires query characters in order', () => {
    expect(fuzzyFilter('vs', [mk('save', 'Save')])).toEqual([]);
  });
});

describe('command registry', () => {
  afterEach(() => {
    for (const c of getCommands()) unregisterCommand(c.id);
  });

  it('dedups by id, last registration wins', () => {
    registerCommand(mk('a', 'First'));
    registerCommand(mk('b', 'Second'));
    registerCommand(mk('a', 'Replaced'));
    const cmds = getCommands();
    expect(cmds).toHaveLength(2);
    expect(cmds.find((c) => c.id === 'a')?.title).toBe('Replaced');
  });

  it('unregisterCommand removes the command and ignores unknown ids', () => {
    registerCommand(mk('a', 'First'));
    registerCommand(mk('b', 'Second'));
    unregisterCommand('a');
    expect(getCommands().map((c) => c.id)).toEqual(['b']);
    unregisterCommand('nope');
    expect(getCommands()).toHaveLength(1);
  });

  it('getCommands preserves registration order', () => {
    registerCommand(mk('a', 'A'));
    registerCommand(mk('b', 'B'));
    registerCommand(mk('c', 'C'));
    expect(getCommands().map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});
