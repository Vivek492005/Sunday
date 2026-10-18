import { describe, expect, it } from 'vitest';
import { parseGitPorcelain, statusLabel } from './gitParse';

describe('parseGitPorcelain', () => {
  it('parses staged, unstaged and untracked files', () => {
    const out = [
      'M  src/a.ts',
      'A  src/b.ts',
      ' M src/c.ts',
      ' D src/d.ts',
      '?? src/new.ts',
      'R  old.ts -> new.ts',
    ].join('\n');
    const { staged, unstaged } = parseGitPorcelain(out);
    expect(staged.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'new.ts']);
    expect(staged.every((f) => f.staged)).toBe(true);
    expect(unstaged.map((f) => `${f.status}:${f.path}`)).toEqual([
      'M:src/c.ts',
      'D:src/d.ts',
      '?:src/new.ts',
    ]);
    expect(unstaged.every((f) => !f.staged)).toBe(true);
  });

  it('handles both-staged-and-unstaged (MM)', () => {
    const { staged, unstaged } = parseGitPorcelain('MM src/x.ts\n');
    expect(staged).toHaveLength(1);
    expect(unstaged).toHaveLength(1);
    expect(staged[0].path).toBe('src/x.ts');
    expect(unstaged[0].path).toBe('src/x.ts');
  });

  it('ignores blank lines and headers', () => {
    const { staged, unstaged } = parseGitPorcelain('\n   \nM  a.ts\n');
    expect(staged).toHaveLength(1);
    expect(unstaged).toHaveLength(0);
  });

  it('returns empty lists for empty output', () => {
    const { staged, unstaged } = parseGitPorcelain('');
    expect(staged).toEqual([]);
    expect(unstaged).toEqual([]);
  });
});

describe('statusLabel', () => {
  it('labels common statuses', () => {
    expect(statusLabel('M')).toBe('Modified');
    expect(statusLabel('A')).toBe('Added');
    expect(statusLabel('?')).toBe('Untracked');
    expect(statusLabel('R')).toBe('Renamed');
  });
});
