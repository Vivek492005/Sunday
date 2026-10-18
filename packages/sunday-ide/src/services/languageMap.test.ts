import { describe, expect, it } from 'vitest';
import { badgeForFile, baseName, languageForFile } from './languageMap';

describe('languageForFile', () => {
  it('maps common extensions', () => {
    expect(languageForFile('app.ts')).toBe('typescript');
    expect(languageForFile('App.TSX')).toBe('typescript');
    expect(languageForFile('index.js')).toBe('javascript');
    expect(languageForFile('styles.css')).toBe('css');
    expect(languageForFile('README.md')).toBe('markdown');
    expect(languageForFile('main.py')).toBe('python');
  });

  it('maps special filenames', () => {
    expect(languageForFile('Dockerfile')).toBe('dockerfile');
  });

  it('falls back to plaintext', () => {
    expect(languageForFile('LICENSE')).toBe('plaintext');
    expect(languageForFile('data.xyz')).toBe('plaintext');
  });
});

describe('badgeForFile', () => {
  it('returns short badges', () => {
    expect(badgeForFile('app.ts')).toBe('TS');
    expect(badgeForFile('pkg.json')).toBe('{}');
    expect(badgeForFile('index.html')).toBe('<>');
  });
});

describe('baseName', () => {
  it('handles posix and windows separators', () => {
    expect(baseName('/a/b/c.ts')).toBe('c.ts');
    expect(baseName('C:\\a\\b.ts')).toBe('b.ts');
  });
});
