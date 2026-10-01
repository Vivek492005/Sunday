import { describe, expect, it } from 'vitest';
import { matchAnyGlob, matchGlob, normalizeForGlob } from './glob.js';

describe('normalizeForGlob', () => {
  it('converts backslashes and strips ./ prefixes', () => {
    expect(normalizeForGlob('src\\app.ts')).toBe('src/app.ts');
    expect(normalizeForGlob('./src/app.ts')).toBe('src/app.ts');
  });
});

describe('matchGlob', () => {
  it('supports * without crossing directories', () => {
    expect(matchGlob('*.ts', 'app.ts')).toBe(true);
    expect(matchGlob('*.ts', 'src/app.ts')).toBe(false);
    expect(matchGlob('src/*.ts', 'src/app.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/deep/app.ts')).toBe(false);
  });

  it('supports ** crossing directories', () => {
    expect(matchGlob('**/*.ts', 'app.ts')).toBe(true);
    expect(matchGlob('**/*.ts', 'src/deep/app.ts')).toBe(true);
    expect(matchGlob('**/*.ts', 'src/app.md')).toBe(false);
    expect(matchGlob('src/**', 'src/a/b.ts')).toBe(true);
    expect(matchGlob('src/**', 'other/a.ts')).toBe(false);
  });

  it('lets trailing /** match the bare directory too', () => {
    expect(matchGlob('docs/**', 'docs')).toBe(true);
    expect(matchGlob('docs/**', 'docs/a.md')).toBe(true);
  });

  it('supports ? for a single character', () => {
    expect(matchGlob('?.ts', 'a.ts')).toBe(true);
    expect(matchGlob('?.ts', 'ab.ts')).toBe(false);
    expect(matchGlob('?.ts', '/.ts')).toBe(false);
  });

  it('escapes regex metacharacters in literals', () => {
    expect(matchGlob('file.(ts)', 'file.(ts)')).toBe(true);
    expect(matchGlob('file.(ts)', 'fileXtsY')).toBe(false);
  });

  it('matches absolute paths against workspaceDir', () => {
    expect(matchGlob('**/*.ts', '/ws/src/app.ts', '/ws')).toBe(true);
    expect(matchGlob('src/*.ts', '/ws/src/app.ts', '/ws')).toBe(true);
  });
});

describe('matchAnyGlob', () => {
  it('returns true when any pattern matches', () => {
    expect(matchAnyGlob(['*.md', '**/*.ts'], 'src/app.ts')).toBe(true);
    expect(matchAnyGlob(['*.md', 'src/*.js'], 'src/app.ts')).toBe(false);
    expect(matchAnyGlob([], 'src/app.ts')).toBe(false);
  });
});
