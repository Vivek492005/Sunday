import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildIndex,
  loadIndex,
  indexFilePath,
  chunkText,
  CHUNK_LINES,
  CHUNK_OVERLAP,
} from './indexer.js';

let root: string;
let home: string;

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function lines(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join('\n') + '\n';
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-idx-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-home-'));
  process.env.SUNDAY_HOME = home;
  write('a.ts', lines(250, 'alpha'));
  write('b.py', lines(30, 'beta'));
});

afterEach(() => {
  delete process.env.SUNDAY_HOME;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('chunkText', () => {
  it('chunks ~120 lines with 20-line overlap and 1-based line numbers', () => {
    const chunks = chunkText(lines(250, 'x'), 'f.ts');
    // 250 lines → [1,120], [101,220], [201,250]
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 120 });
    expect(chunks[1]).toMatchObject({ startLine: 101, endLine: 220 });
    expect(chunks[2]).toMatchObject({ startLine: 201, endLine: 250 });
    // overlap: last 20 lines of chunk 0 == first 20 of chunk 1
    const c0 = chunks[0]!.text.split('\n').slice(-CHUNK_OVERLAP).join('\n');
    const c1 = chunks[1]!.text.split('\n').slice(0, CHUNK_OVERLAP).join('\n');
    expect(c0).toBe(c1);
    expect(CHUNK_LINES).toBe(120);
  });

  it('is deterministic: same input → same ids and hashes', () => {
    const a = chunkText(lines(300, 'det'), 'f.ts');
    const b = chunkText(lines(300, 'det'), 'f.ts');
    expect(a).toEqual(b);
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
  });
});

describe('buildIndex', () => {
  it('indexes text files and persists the index under ~/.sunday/index', () => {
    const stats = buildIndex(root);
    expect(stats.files).toBe(2);
    expect(stats.chunks).toBe(3 + 1); // 250-line file → 3 chunks, 30-line → 1
    expect(stats.skipped).toBe(0);
    expect(stats.reused).toBe(0);
    expect(fs.existsSync(indexFilePath(root))).toBe(true);
    const loaded = loadIndex(root);
    expect(loaded?.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.py']);
  });

  it('is deterministic across runs and reuses unchanged files', () => {
    buildIndex(root);
    const before = JSON.stringify(loadIndex(root));
    const stats2 = buildIndex(root);
    const after = JSON.stringify(loadIndex(root));
    // Same chunks/hashes; only createdAt may differ — compare file entries.
    const norm = (s: string) => JSON.stringify({ ...JSON.parse(s), createdAt: '' });
    expect(norm(after)).toBe(norm(before));
    expect(stats2.reused).toBe(stats2.chunks);
    expect(stats2.skipped).toBe(0);
  });

  it('re-chunks only changed files; force rebuilds everything', () => {
    const first = buildIndex(root);
    write('b.py', lines(30, 'beta-changed')); // size change → re-chunk
    const second = buildIndex(root);
    expect(second.reused).toBe(first.chunks - 1); // a.ts chunks reused
    expect(second.chunks).toBe(first.chunks);
    const forced = buildIndex(root, { force: true });
    expect(forced.reused).toBe(0);
    expect(forced.chunks).toBe(first.chunks);
  });

  it('skips binary files and files over 1MB', () => {
    write('bin.dat', 'x'); // then make it binary + large
    const abs = path.join(root, 'bin.dat');
    fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    write('huge.txt', 'y');
    fs.truncateSync(path.join(root, 'huge.txt'), 2 * 1024 * 1024);
    const stats = buildIndex(root);
    expect(stats.skipped).toBe(2);
    expect(stats.files).toBe(2);
  });

  it('prunes deleted files from the index', () => {
    buildIndex(root);
    fs.rmSync(path.join(root, 'b.py'));
    const stats = buildIndex(root);
    expect(stats.files).toBe(1);
    expect(loadIndex(root)?.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('throws for a missing root', () => {
    expect(() => buildIndex(path.join(root, 'nope'))).toThrow();
  });
});
