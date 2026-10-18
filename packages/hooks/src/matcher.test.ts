import { describe, expect, it } from 'vitest';
import {
  globToRegExp,
  hookMatches,
  matchesAny,
  normalizePathForMatch,
  primaryPathFromArgs,
} from './matcher.js';

describe('globToRegExp', () => {
  it('matches * within a segment only', () => {
    const re = globToRegExp('run_*');
    expect(re.test('run_terminal')).toBe(true);
    expect(re.test('run_x_y')).toBe(true);
    expect(re.test('run_terminal/extra')).toBe(false);
  });
  it('matches ** across segments', () => {
    const re = globToRegExp('**/.env');
    expect(re.test('.env')).toBe(true);
    expect(re.test('a/b/.env')).toBe(true);
    expect(re.test('a/b/.env.local')).toBe(false);
  });
  it('trailing /** matches the bare dir too', () => {
    const re = globToRegExp('src/**');
    expect(re.test('src')).toBe(true);
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/a/b.ts')).toBe(true);
    expect(re.test('srcfoo')).toBe(false);
  });
  it('matches ? as a single char', () => {
    const re = globToRegExp('file.???');
    expect(re.test('file.tsx')).toBe(true);
    expect(re.test('file.ts')).toBe(false);
    expect(re.test('file.tool')).toBe(false);
  });
  it('escapes regex metacharacters', () => {
    const re = globToRegExp('a.b(c)');
    expect(re.test('a.b(c)')).toBe(true);
    expect(re.test('axb(c)')).toBe(false);
  });
});

describe('matchesAny', () => {
  it('empty patterns = match-all', () => {
    expect(matchesAny('anything', [])).toBe(true);
  });
});

describe('normalizePathForMatch', () => {
  it('converts backslashes', () => {
    expect(normalizePathForMatch('C:\\a\\b\\.env')).toBe('C:/a/b/.env');
  });
});

describe('primaryPathFromArgs', () => {
  it('extracts path/file/filePath', () => {
    expect(primaryPathFromArgs({ path: '/x/.env' })).toBe('/x/.env');
    expect(primaryPathFromArgs({ file: 'a.ts' })).toBe('a.ts');
    expect(primaryPathFromArgs({ filePath: 'b.ts' })).toBe('b.ts');
    expect(primaryPathFromArgs({ other: 1 })).toBeUndefined();
    expect(primaryPathFromArgs(null)).toBeUndefined();
  });
});

describe('hookMatches', () => {
  it('matches tool globs', () => {
    expect(hookMatches({ tools: ['read_*'], paths: [] }, 'read_file', {})).toBe(true);
    expect(hookMatches({ tools: ['read_*'], paths: [] }, 'write_file', {})).toBe(false);
  });
  it('path-scoped hook requires an extractable path (fail closed)', () => {
    // No path in args → does NOT match, so a block can't be bypassed.
    expect(
      hookMatches({ tools: [], paths: ['**/.env'] }, 'read_file', { other: 1 }),
    ).toBe(false);
    expect(hookMatches({ tools: [], paths: ['**/.env'] }, 'read_file', { path: '.env' })).toBe(
      true,
    );
    expect(
      hookMatches({ tools: [], paths: ['**/.env'] }, 'read_file', { path: 'src/a.ts' }),
    ).toBe(false);
  });
  it('matches windows-style paths', () => {
    expect(
      hookMatches({ tools: [], paths: ['**/.env'] }, 'read_file', { path: 'C:\\proj\\.env' }),
    ).toBe(true);
  });
});
