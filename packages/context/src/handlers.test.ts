import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createContextHandlers } from './handlers.js';

let root: string;
let home: string;

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-handlers-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-home-'));
  process.env.SUNDAY_HOME = home;
  write('src/main.ts', 'export const main = 1;\n');
  write('src/util.py', 'VALUE = 2\n');
});

afterEach(() => {
  delete process.env.SUNDAY_HOME;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('createContextHandlers', () => {
  it('context/map returns the shaped repo map', async () => {
    const h = createContextHandlers(root);
    const res = await h['context/map']({ workspaceRoot: root });
    expect(res.totalFiles).toBe(2);
    expect(res.totalBytes).toBeGreaterThan(0);
    expect(res.files.map((f) => f.path).sort()).toEqual(['src/main.ts', 'src/util.py']);
    expect(res.files.find((f) => f.path === 'src/main.ts')).toMatchObject({
      lang: 'typescript',
    });
  });

  it('context/index builds the index and returns stats', async () => {
    const h = createContextHandlers(root);
    const res = await h['context/index']({ workspaceRoot: root });
    expect(res).toEqual({ files: 2, chunks: 2, skipped: 0 });
    const forced = await h['context/index']({ workspaceRoot: root, force: true });
    expect(forced).toEqual({ files: 2, chunks: 2, skipped: 0 });
  });

  it('context/search round-trips through map → index → search', async () => {
    const h = createContextHandlers(root);
    await h['context/index']({ workspaceRoot: root });
    const res = await h['context/search']({ query: 'main', k: 5 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0]!.path).toBe('src/main.ts');
    const hit = res.hits[0]!;
    expect(hit.startLine).toBeGreaterThanOrEqual(1);
    expect(hit.endLine).toBeGreaterThanOrEqual(hit.startLine);
    expect(typeof hit.score).toBe('number');
    expect(typeof hit.snippet).toBe('string');
  });

  it('search defaults to the bound root when workspaceRoot is omitted', async () => {
    const h = createContextHandlers(root);
    await h['context/index']({ workspaceRoot: root });
    const res = await h['context/search']({ query: 'VALUE' });
    expect(res.hits[0]!.path).toBe('src/util.py');
  });

  it('rejects invalid params', async () => {
    const h = createContextHandlers(root);
    await expect(h['context/map']({})).rejects.toThrow(/workspaceRoot/);
    await expect(h['context/map']('nope')).rejects.toThrow(/expected an object/);
    await expect(h['context/index']({ workspaceRoot: root, force: 'yes' })).rejects.toThrow(
      /force/,
    );
    await expect(h['context/search']({ query: '' })).rejects.toThrow(/query/);
    await expect(h['context/search']({ query: 'x', k: 0 })).rejects.toThrow(/\[1, 50\]/);
    await expect(h['context/search']({ query: 'x', k: 51 })).rejects.toThrow(/\[1, 50\]/);
    await expect(h['context/search']({ query: 'x', maxChars: 200_000 })).rejects.toThrow(
      /\[1, 100000\]/,
    );
  });

  it('rejects a workspaceRoot that escapes the bound root', async () => {
    const h = createContextHandlers(root);
    const outside = path.resolve(root, '..');
    await expect(h['context/map']({ workspaceRoot: outside })).rejects.toThrow(/escapes/);
    await expect(h['context/search']({ workspaceRoot: outside, query: 'x' })).rejects.toThrow(
      /escapes/,
    );
  });

  it('rejects a missing workspace root', async () => {
    const h = createContextHandlers(root);
    await expect(
      h['context/map']({ workspaceRoot: path.join(root, 'nope') }),
    ).rejects.toThrow(/not found/);
  });
});
