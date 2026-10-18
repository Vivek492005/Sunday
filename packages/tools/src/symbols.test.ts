import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createDefaultRegistry,
  findReferencesTool,
  symbolOutlineTool,
  impactOfChangeTool,
  type ToolContext,
} from './index.js';

let tmp: string;
let ctx: ToolContext;
let home: string;
const savedHome = process.env.SUNDAY_HOME;

const APP_TS = `import { helper } from './util';

export function processItems(items: string[]): string[] {
  return items.map(helper);
}

export class Runner {
  run(): void {
    const out = processItems(['a']);
    console.log(out);
  }
}
`;

const UTIL_TS = `export function helper(s: string): string {
  return s.toUpperCase();
}
`;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sunday-symtools-')));
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sunday-symhome-')));
  process.env.SUNDAY_HOME = home;
  ctx = { cwd: tmp };
  await fs.writeFile(path.join(tmp, 'app.ts'), APP_TS);
  await fs.writeFile(path.join(tmp, 'util.ts'), UTIL_TS);
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SUNDAY_HOME;
  else process.env.SUNDAY_HOME = savedHome;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

describe('symbol tools are registered', () => {
  it('registry exposes find_references, symbol_outline, impact_of_change', () => {
    const r = createDefaultRegistry();
    expect(r.names()).toContain('find_references');
    expect(r.names()).toContain('symbol_outline');
    expect(r.names()).toContain('impact_of_change');
  });
});

describe('find_references', () => {
  it('finds the definition and usages of a symbol', async () => {
    const res = await findReferencesTool.execute({ symbol: 'helper' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('util.ts:1');
    expect(res.output).toContain('[definition]');
    expect(res.output).toContain('app.ts');
  });

  it('reports when nothing references the symbol', async () => {
    const res = await findReferencesTool.execute({ symbol: 'nope_nothing' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('no references');
  });
});

describe('symbol_outline', () => {
  it('lists symbols in a file', async () => {
    const res = await symbolOutlineTool.execute({ path: 'app.ts' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('function processItems');
    expect(res.output).toContain('class Runner');
    expect(res.output).toContain('method run');
  });

  it('rejects paths escaping the workspace', async () => {
    const res = await symbolOutlineTool.execute({ path: '../evil.ts' }, ctx);
    expect(res.isError).toBe(true);
  });
});

describe('impact_of_change', () => {
  it('finds transitive callers', async () => {
    const res = await impactOfChangeTool.execute({ symbol: 'helper', path: 'util.ts' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('processItems'); // direct caller
    expect(res.output).toContain('run'); // transitive caller via processItems
  });

  it('reports a missing symbol', async () => {
    const res = await impactOfChangeTool.execute({ symbol: 'ghost' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('not found');
  });
});
