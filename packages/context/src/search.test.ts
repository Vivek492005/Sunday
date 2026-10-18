import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildIndex } from './indexer.js';
import { searchWorkspaceIndex, tokenize, fuse, hybridSearch } from './search.js';

let root: string;
let home: string;

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-search-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-home-'));
  process.env.SUNDAY_HOME = home;
  write(
    'zephyr.ts',
    [
      '// the zephyr protocol coordinates quadtrees',
      'export function zephyrHandshake() {',
      '  return "zephyr-ok";',
      '}',
      '// zephyr zephyr zephyr',
    ].join('\n') + '\n',
  );
  write(
    'generic.ts',
    ['export function helper() {', '  return 42;', '}', '// nothing special here'].join('\n') +
      '\n',
  );
  write('other.md', '# docs\n\nSome prose about nothing in particular.\n');
  buildIndex(root);
});

afterEach(() => {
  delete process.env.SUNDAY_HOME;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('Hello, WORLD_42!')).toEqual(['hello', 'world', '42']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('searchWorkspaceIndex', () => {
  it('ranks the obviously-relevant chunk first', () => {
    const hits = searchWorkspaceIndex(root, 'zephyr');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe('zephyr.ts');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('returns shaped hits with snippets around the match', () => {
    const hits = searchWorkspaceIndex(root, 'quadtrees', { k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    const h = hits[0]!;
    expect(h.path).toBe('zephyr.ts');
    expect(h.startLine).toBe(1);
    expect(h.endLine).toBeGreaterThanOrEqual(5);
    expect(h.snippet.toLowerCase()).toContain('quadtrees');
    expect(typeof h.score).toBe('number');
  });

  it('is deterministic: same query → same hits', () => {
    const a = searchWorkspaceIndex(root, 'zephyr');
    const b = searchWorkspaceIndex(root, 'zephyr');
    expect(a).toEqual(b);
  });

  it('respects k and the maxChars budget', () => {
    const hits = searchWorkspaceIndex(root, 'the', { k: 2, maxChars: 60 });
    expect(hits.length).toBeLessThanOrEqual(2);
    const total = hits.reduce((n, h) => n + h.snippet.length, 0);
    expect(total).toBeLessThanOrEqual(60);
  });

  it('marks truncation when the budget cuts a snippet', () => {
    const hits = searchWorkspaceIndex(root, 'zephyr', { k: 1, maxChars: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(10);
    expect(hits[0]!.snippet.endsWith('…')).toBe(true);
  });

  it('returns no hits for terms absent from the index', () => {
    expect(searchWorkspaceIndex(root, 'qqqzzz-nope')).toEqual([]);
  });

  it('throws a helpful error when no index exists', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-empty-'));
    try {
      expect(() => searchWorkspaceIndex(empty, 'x')).toThrow(/run context\/index first/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('populates an explainable `why` on every hit', () => {
    const hits = searchWorkspaceIndex(root, 'zephyr');
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(typeof h.why).toBe('string');
      expect(h.why.length).toBeGreaterThan(0);
      expect(h.why).toContain('TF-IDF');
    }
  });
});

describe('fuse (Reciprocal Rank Fusion)', () => {
  it('a doc ranked #1 in two lists beats a doc ranked #1 in one', () => {
    const lists = [
      [{ key: 'a', why: 's1' }, { key: 'b', why: 's1' }],
      [{ key: 'b', why: 's2' }, { key: 'c', why: 's2' }],
    ];
    const fused = fuse(lists, 3);
    expect(fused[0]!.key).toBe('b');
    expect(fused[0]!.whys).toContain('s1');
    expect(fused[0]!.whys).toContain('s2');
  });

  it('is deterministic and deduplicates whys', () => {
    const lists = [
      [{ key: 'a', why: 'x' }],
      [{ key: 'a', why: 'x' }],
    ];
    const a = fuse(lists, 5);
    const b = fuse(lists, 5);
    expect(a).toEqual(b);
    expect(a[0]!.whys).toEqual(['x']);
  });

  it('respects k', () => {
    const lists = [[{ key: 'a', why: 'x' }, { key: 'b', why: 'x' }, { key: 'c', why: 'x' }]];
    expect(fuse(lists, 2)).toHaveLength(2);
  });
});

describe('hybridSearch', () => {
  async function saveGraphFor(files: string[]): Promise<void> {
    const { buildSymbolGraph, saveSymbolGraph } = await import('./symbols.js');
    const inputs = files.map((p) => ({
      path: p,
      text: fs.readFileSync(path.join(root, p), 'utf8'),
    }));
    saveSymbolGraph(await buildSymbolGraph(root, inputs));
  }

  it('returns explainable hits fusing TF-IDF + symbols', async () => {
    await saveGraphFor(['zephyr.ts', 'generic.ts']);
    const hits = await hybridSearch(root, 'zephyrHandshake');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe('zephyr.ts');
    for (const h of hits) {
      expect(h.why.length).toBeGreaterThan(0);
    }
    // The symbol signal should explain the definition match.
    expect(hits.some((h) => h.why.includes('defines symbol'))).toBe(true);
  });

  it('surfaces referencing files via the symbol signal', async () => {
    write('caller.ts', 'import { zephyrHandshake } from "./zephyr";\nzephyrHandshake();\n');
    buildIndex(root);
    await saveGraphFor(['zephyr.ts', 'caller.ts']);
    const hits = await hybridSearch(root, 'zephyrHandshake');
    const paths = hits.map((h) => h.path);
    expect(paths).toContain('caller.ts');
    const callerHit = hits.find((h) => h.path === 'caller.ts');
    expect(callerHit!.why).toContain('references symbol');
  });

  it('works with no symbol graph (TF-IDF only)', async () => {
    const hits = await hybridSearch(root, 'zephyr', { noSymbols: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe('zephyr.ts');
  });

  it('throws a helpful error when no index exists', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-empty-'));
    try {
      await expect(hybridSearch(empty, 'x')).rejects.toThrow(/run context\/index first/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
