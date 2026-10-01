import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildRepoMap,
  detectLang,
  parseIgnoreRule,
  isIgnored,
  loadIgnoreRules,
} from './repoMap.js';

let root: string;

function write(rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-map-'));
  write('.gitignore', '*.log\nbuild/\n!keep.log\n**/secret.txt\n');
  write('src/index.ts', 'export const x = 1;\n');
  write('src/app.py', "print('hi')\n");
  write('README.md', '# hi\n');
  write('notes.txt', 'plain\n');
  write('debug.log', 'noise\n');
  write('keep.log', 'kept\n');
  write('build/out.js', 'console.log(1)\n');
  write('sub/secret.txt', 'shh\n');
  write('node_modules/pkg/i.js', 'x\n');
  write('.git/HEAD', 'ref\n');
  // 6MB sparse file — over the 5MB map cap, but instant to create.
  const big = path.join(root, 'big.bin');
  fs.writeFileSync(big, 'x');
  fs.truncateSync(big, 6 * 1024 * 1024);
  write('Dockerfile', 'FROM node\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseIgnoreRule / isIgnored', () => {
  it('ignores blanks and comments', () => {
    expect(parseIgnoreRule('')).toBeNull();
    expect(parseIgnoreRule('  ')).toBeNull();
    expect(parseIgnoreRule('# comment')).toBeNull();
  });

  it('matches * at any depth, ** across separators, ! negates', () => {
    const rules = ['*.log', '!keep.log', '**/secret.txt', 'build/']
      .map(parseIgnoreRule)
      .filter((r): r is NonNullable<typeof r> => r !== null);
    expect(isIgnored('debug.log', rules)).toBe(true);
    expect(isIgnored('sub/debug.log', rules)).toBe(true);
    // `*.log` matches first, `!keep.log` matches last → re-included.
    expect(isIgnored('keep.log', rules)).toBe(false);
    expect(isIgnored('sub/secret.txt', rules)).toBe(true);
    expect(isIgnored('build/out.js', rules)).toBe(true);
    expect(isIgnored('src/index.ts', rules)).toBe(false);
  });

  it('directory patterns prune the whole subtree', () => {
    const rules = loadIgnoreRules(root);
    expect(isIgnored('build', rules)).toBe(true);
    expect(isIgnored('build/out.js', rules)).toBe(true);
  });
});

describe('buildRepoMap', () => {
  it('lists files with posix paths, sizes and languages', () => {
    const map = buildRepoMap(root);
    const byPath = new Map(map.files.map((f) => [f.path, f]));
    expect(byPath.get('src/index.ts')?.lang).toBe('typescript');
    expect(byPath.get('src/app.py')?.lang).toBe('python');
    expect(byPath.get('README.md')?.lang).toBe('markdown');
    expect(byPath.get('notes.txt')?.lang).toBe('unknown');
    expect(byPath.get('Dockerfile')?.lang).toBe('docker');
    expect(byPath.get('keep.log')?.lang).toBe('unknown');
    // posix separators, no backslashes, sorted
    const paths = map.files.map((f) => f.path);
    expect(paths.every((p) => !p.includes('\\'))).toBe(true);
    expect([...paths].sort()).toEqual(paths);
    expect(map.totalFiles).toBe(map.files.length);
    expect(map.totalBytes).toBe(map.files.reduce((n, f) => n + f.size, 0));
  });

  it('excludes .gitignore hits, node_modules, .git and oversized files', () => {
    const map = buildRepoMap(root);
    const paths = new Set(map.files.map((f) => f.path));
    expect(paths.has('debug.log')).toBe(false);
    expect(paths.has('build/out.js')).toBe(false);
    expect(paths.has('sub/secret.txt')).toBe(false);
    expect(paths.has('node_modules/pkg/i.js')).toBe(false);
    expect(paths.has('.git/HEAD')).toBe(false);
    expect(paths.has('big.bin')).toBe(false);
    expect(paths.has('keep.log')).toBe(true); // negated back in
    expect(map.skipped).toContain('big.bin');
  });

  it('throws for a missing or non-directory root', () => {
    expect(() => buildRepoMap(path.join(root, 'nope'))).toThrow();
    expect(() => buildRepoMap(path.join(root, 'README.md'))).toThrow();
  });
});

describe('detectLang', () => {
  it('maps common extensions and falls back to unknown', () => {
    expect(detectLang('a.ts')).toBe('typescript');
    expect(detectLang('a.TS')).toBe('typescript');
    expect(detectLang('a.jsx')).toBe('jsx');
    expect(detectLang('a.go')).toBe('go');
    expect(detectLang('a.rs')).toBe('rust');
    expect(detectLang('a.json')).toBe('json');
    expect(detectLang('a.yml')).toBe('yaml');
    expect(detectLang('noext')).toBe('unknown');
    expect(detectLang('weird.zzz')).toBe('unknown');
  });
});
