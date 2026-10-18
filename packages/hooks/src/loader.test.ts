import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashHooksBytes, loadHooks } from './loader.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeTree(repoHooks?: unknown, userHooks?: unknown): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'hooks-root-'));
  const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
  dirs.push(root, home);
  if (repoHooks !== undefined) {
    mkdirSync(join(root, '.sunday'), { recursive: true });
    writeFileSync(join(root, '.sunday', 'hooks.json'), JSON.stringify(repoHooks));
  }
  if (userHooks !== undefined) {
    mkdirSync(join(home, '.sunday'), { recursive: true });
    writeFileSync(join(home, '.sunday', 'hooks.json'), JSON.stringify(userHooks));
  }
  return { root, home };
}

const HOOK_A = {
  version: 1,
  hooks: [{ name: 'a', event: 'pre_tool', actions: [{ type: 'annotate', text: 'a' }] }],
};

describe('loader', () => {
  it('returns empty when no files exist', () => {
    const { root, home } = makeTree();
    const r = loadHooks(root, home);
    expect(r.hooks).toEqual([]);
    expect(r.repoHash).toBeUndefined();
    expect(r.errors).toEqual([]);
  });
  it('loads repo hooks and hashes bytes', () => {
    const { root, home } = makeTree(HOOK_A);
    const r = loadHooks(root, home);
    expect(r.hooks).toHaveLength(1);
    expect(r.hooks[0].source).toBe('repo');
    expect(r.repoHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.repoHash).toBe(hashHooksBytes(JSON.stringify(HOOK_A)));
  });
  it('merges user hooks after repo hooks', () => {
    const { root, home } = makeTree(HOOK_A, {
      version: 1,
      hooks: [{ name: 'u', event: 'post_tool', actions: [{ type: 'annotate', text: 'u' }] }],
    });
    const r = loadHooks(root, home);
    expect(r.hooks.map((h) => h.name)).toEqual(['a', 'u']);
    expect(r.hooks[1].source).toBe('user');
  });
  it('user disable: hook turns off the repo hook', () => {
    const { root, home } = makeTree(HOOK_A, {
      version: 1,
      hooks: [
        { name: 'disable:a', event: 'pre_tool', actions: [{ type: 'annotate', text: 'x' }] },
      ],
    });
    const r = loadHooks(root, home);
    expect(r.hooks).toEqual([]);
  });
  it('skips disabled hooks, reports bad files as errors (never throws)', () => {
    const { root, home } = makeTree({
      version: 1,
      hooks: [
        { name: 'on', event: 'pre_tool', actions: [{ type: 'annotate', text: 'on' }] },
        { name: 'off', event: 'pre_tool', enabled: false, actions: [{ type: 'annotate', text: 'x' }] },
      ],
    });
    mkdirSync(join(home, '.sunday'), { recursive: true });
    writeFileSync(join(home, '.sunday', 'hooks.json'), '{ not json');
    const r = loadHooks(root, home);
    expect(r.hooks.map((h) => h.name)).toEqual(['on']);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatch(/invalid JSON/);
  });
  it('hash changes when bytes change', () => {
    expect(hashHooksBytes('a')).not.toBe(hashHooksBytes('b'));
  });
});
