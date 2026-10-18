import { describe, expect, it } from 'vitest';
import {
  buildSymbolGraph,
  extractFileSymbols,
  findReferences,
  graphStats,
  impactOfChange,
  supportedLanguageForPath,
  symbolOutline,
  updateSymbolGraph,
} from './symbols.js';

const TS_SAMPLE = `import { helper } from './util';
import fs from 'node:fs';

export function greet(name: string): string {
  return helper(name);
}

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}

const double = (x: number): number => x * 2;

function main(): void {
  const c = new Calculator();
  console.log(greet('world'), double(21));
  c.add(1, 2);
}
`;

const PY_SAMPLE = `import os
from pathlib import Path

def greet(name):
    return f"hello {name}"

class Calculator:
    def add(self, a, b):
        return a + b

def main():
    c = Calculator()
    print(greet("world"))
    c.add(1, 2)
`;

describe('supportedLanguageForPath', () => {
  it('maps extensions', () => {
    expect(supportedLanguageForPath('a.ts')).toBe('typescript');
    expect(supportedLanguageForPath('a.tsx')).toBe('typescript');
    expect(supportedLanguageForPath('a.js')).toBe('javascript');
    expect(supportedLanguageForPath('a.py')).toBe('python');
    expect(supportedLanguageForPath('a.md')).toBeNull();
    expect(supportedLanguageForPath('a.go')).toBeNull();
  });
});

describe('extractFileSymbols (TypeScript)', () => {
  it('extracts definitions', async () => {
    const { symbols } = await extractFileSymbols('src/app.ts', TS_SAMPLE);
    const names = symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('function:greet');
    expect(names).toContain('class:Calculator');
    expect(names).toContain('method:add');
    expect(names).toContain('function:double'); // arrow fn assigned to var
    expect(names).toContain('function:main');
    expect(names).toContain('import:import ./util');
  });

  it('attributes method container', async () => {
    const { symbols } = await extractFileSymbols('src/app.ts', TS_SAMPLE);
    const add = symbols.find((s) => s.name === 'add');
    expect(add?.container).toBe('Calculator');
  });

  it('extracts call edges (unresolved `name::` form)', async () => {
    const { edges } = await extractFileSymbols('src/app.ts', TS_SAMPLE);
    const calls = edges.filter((e) => e.kind === 'calls');
    // main calls greet, double, add; greet calls helper
    const targets = calls.map((c) => c.to);
    expect(targets).toContain('name::greet');
    expect(targets).toContain('name::helper');
  });

  it('buildSymbolGraph resolves call targets across files', async () => {
    const g = await buildSymbolGraph('/root', [
      { path: 'a.ts', text: TS_SAMPLE },
      { path: 'b.ts', text: 'import { greet } from "./a";\nexport function other() { greet("x"); }\n' },
    ]);
    const edges = Object.values(g.files).flatMap((f) => f.edges);
    const greetCall = edges.find((e) => e.kind === 'calls' && e.to.includes('::function::greet@'));
    expect(greetCall).toBeDefined();
    expect(greetCall!.to.startsWith('a.ts::')).toBe(true); // resolved to a.ts definition
    // helper has no definition in the graph -> external
    expect(edges.some((e) => e.kind === 'calls' && e.to === 'external::helper')).toBe(true);
  });

  it('collects identifier references', async () => {
    const { refs } = await extractFileSymbols('src/app.ts', TS_SAMPLE);
    const greetRefs = refs.filter((r) => r.name === 'greet');
    expect(greetRefs.length).toBeGreaterThanOrEqual(2); // def + call in main
    expect(greetRefs.some((r) => r.isDefinition)).toBe(true);
  });
});

describe('extractFileSymbols (Python)', () => {
  it('extracts definitions and calls', async () => {
    const { symbols, edges } = await extractFileSymbols('pkg/mod.py', PY_SAMPLE);
    const names = symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('function:greet');
    expect(names).toContain('class:Calculator');
    expect(names).toContain('method:add');
    expect(names).toContain('function:main');
    const calls = edges.filter((e) => e.kind === 'calls');
    expect(calls.some((c) => c.to.includes('greet'))).toBe(true);
  });
});

describe('graph build / incremental update', () => {
  it('builds and stats', async () => {
    const g = await buildSymbolGraph('/root', [
      { path: 'a.ts', text: TS_SAMPLE },
      { path: 'b.py', text: PY_SAMPLE },
      { path: 'c.md', text: '# no' },
    ]);
    const stats = graphStats(g);
    expect(stats.files).toBe(2);
    expect(stats.symbols).toBeGreaterThan(5);
    expect(stats.edges).toBeGreaterThan(2);
  });

  it('skips unchanged files on update (hash-based)', async () => {
    const g = await buildSymbolGraph('/root', [{ path: 'a.ts', text: TS_SAMPLE }]);
    const res = await updateSymbolGraph(g, [{ path: 'a.ts', text: TS_SAMPLE }]);
    expect(res.updated).toEqual([]);
    const res2 = await updateSymbolGraph(g, [{ path: 'a.ts', text: TS_SAMPLE + '\n// x' }]);
    expect(res2.updated).toEqual(['a.ts']);
  });

  it('drops deleted files', async () => {
    const g = await buildSymbolGraph('/root', [{ path: 'a.ts', text: TS_SAMPLE }]);
    const res = await updateSymbolGraph(g, [], ['a.ts']);
    expect(res.removed).toEqual(['a.ts']);
    expect(graphStats(g).files).toBe(0);
  });
});

describe('queries', () => {
  it('findReferences finds def + usages', async () => {
    const g = await buildSymbolGraph('/root', [{ path: 'a.ts', text: TS_SAMPLE }]);
    const hits = findReferences(g, 'greet');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.some((h) => h.isDefinition)).toBe(true);
    expect(hits.every((h) => h.path === 'a.ts')).toBe(true);
  });

  it('symbolOutline lists file symbols in order', async () => {
    const g = await buildSymbolGraph('/root', [{ path: 'a.ts', text: TS_SAMPLE }]);
    const outline = symbolOutline(g, 'a.ts');
    expect(outline.length).toBeGreaterThan(3);
    expect(outline[0]!.startLine).toBeLessThanOrEqual(outline[1]!.startLine);
    expect(outline.every((s) => s.kind !== 'import')).toBe(true);
  });

  it('impactOfChange finds transitive callers', async () => {
    const g = await buildSymbolGraph('/root', [{ path: 'a.ts', text: TS_SAMPLE }]);
    const greet = Object.values(g.files)
      .flatMap((f) => f.symbols)
      .find((s) => s.name === 'greet' && s.kind === 'function')!;
    const impact = impactOfChange(g, greet.id);
    const callerNames = impact.map((n) => n.symbol.name);
    expect(callerNames).toContain('main'); // main calls greet
    expect(impact.every((n) => n.depth >= 1)).toBe(true);
  });

  it('impactOfChange is read-only', async () => {
    const g = await buildSymbolGraph('/root', [{ path: 'a.ts', text: TS_SAMPLE }]);
    const before = JSON.stringify(g);
    const greet = Object.values(g.files)
      .flatMap((f) => f.symbols)
      .find((s) => s.name === 'greet')!;
    impactOfChange(g, greet.id);
    expect(JSON.stringify(g)).toBe(before);
  });

  it('impactOfChange flags reference-only users (callback passed, not called)', async () => {
    const g = await buildSymbolGraph('/root', [
      { path: 'u.ts', text: 'export function helper(s: string): string { return s; }\n' },
      {
        path: 'a.ts',
        text: "import { helper } from './u';\nexport function processItems(xs: string[]) {\n  return xs.map(helper);\n}\n",
      },
    ]);
    const helper = Object.values(g.files)
      .flatMap((f) => f.symbols)
      .find((s) => s.name === 'helper' && s.path === 'u.ts')!;
    const impact = impactOfChange(g, helper.id);
    expect(impact.map((n) => n.symbol.name)).toContain('processItems');
  });
});

describe('graceful degradation', () => {
  it('unsupported language yields empty collections', async () => {
    const r = await extractFileSymbols('doc.md', '# hello');
    expect(r.symbols).toEqual([]);
    expect(r.edges).toEqual([]);
  });
});
