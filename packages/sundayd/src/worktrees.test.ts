// Tests for WorktreeManager: add/list/remove/merge over temp git repos.
// No network.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorktreeManager } from './worktrees.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeScratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-wt-test-'));
}

/** Temp git repo on `main` with one committed file. */
function makeRepo(): string {
  const dir = makeScratch();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.test');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

function makeManager() {
  return new WorktreeManager(makeScratch());
}

describe('WorktreeManager', () => {
  it('adds a worktree on a new branch with a default path', async () => {
    const mgr = makeManager();
    const root = makeRepo();
    const { path: wtPath, branch } = await mgr.add({ repoRoot: root, branch: 'feature/x' });
    expect(branch).toBe('feature/x');
    expect(fs.statSync(wtPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(wtPath, 'a.txt'), 'utf8')).toBe('v1\n');

    const { worktrees } = await mgr.list(root);
    const wt = worktrees.find((w) => w.path === path.resolve(wtPath));
    expect(wt).toBeDefined();
    expect(wt!.branch).toBe('feature/x');
    expect(wt!.head).toMatch(/^[0-9a-f]{40}$/);
    // The main worktree is listed too.
    expect(worktrees.some((w) => w.branch === 'main')).toBe(true);
  });

  it('honors an explicit path and attaches to an existing branch', async () => {
    const mgr = makeManager();
    const root = makeRepo();
    git(root, 'branch', 'existing');
    const explicit = path.join(makeScratch(), 'wt-explicit');
    const res = await mgr.add({ repoRoot: root, branch: 'existing', path: explicit });
    expect(res.path).toBe(path.resolve(explicit));
    const { worktrees } = await mgr.list(root);
    expect(worktrees.some((w) => w.path === path.resolve(explicit) && w.branch === 'existing')).toBe(true);
  });

  it('rejects invalid branch names', async () => {
    const mgr = makeManager();
    const root = makeRepo();
    await expect(mgr.add({ repoRoot: root, branch: 'bad name!' })).rejects.toThrow(/invalid branch/);
    await expect(mgr.add({ repoRoot: root, branch: '..' })).rejects.toThrow(/invalid branch/);
  });

  it('removes a worktree and refuses unregistered paths', async () => {
    const mgr = makeManager();
    const root = makeRepo();
    const { path: wtPath } = await mgr.add({ repoRoot: root, branch: 'feature/gone' });
    const { removed } = await mgr.remove({ repoRoot: root, path: wtPath });
    expect(removed).toBe(true);
    const { worktrees } = await mgr.list(root);
    expect(worktrees.some((w) => w.path === path.resolve(wtPath))).toBe(false);

    await expect(mgr.remove({ repoRoot: root, path: path.join(root, 'nope') })).rejects.toThrow(
      /not a registered worktree/,
    );
    await expect(mgr.remove({ repoRoot: root, path: root })).rejects.toThrow(/main worktree/);
  });

  it('merges a worktree branch into the current branch with --no-ff', async () => {
    const mgr = makeManager();
    const root = makeRepo();
    const { path: wtPath } = await mgr.add({ repoRoot: root, branch: 'feature/add' });
    fs.writeFileSync(path.join(wtPath, 'b.txt'), 'from-feature\n');
    git(wtPath, 'add', '-A');
    git(wtPath, 'commit', '-qm', 'add b');

    const res = await mgr.merge({ repoRoot: root, path: wtPath });
    expect(res.merged).toBe(true);
    expect(res.target).toBe('main');
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.sha).toBe(git(root, 'rev-parse', 'HEAD').trim());
    // --no-ff produced a real merge commit (2 parents).
    expect(git(root, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('from-feature\n');
  });

  it('merges into an explicit target branch', async () => {
    const mgr = makeManager();
    const root = makeRepo();
    git(root, 'checkout', '-qb', 'dev');
    const { path: wtPath } = await mgr.add({ repoRoot: root, branch: 'feature/dev-add' });
    fs.writeFileSync(path.join(wtPath, 'c.txt'), 'c\n');
    git(wtPath, 'add', '-A');
    git(wtPath, 'commit', '-qm', 'add c');
    // Main checkout is on dev; ask for main explicitly.
    const res = await mgr.merge({ repoRoot: root, path: wtPath, target: 'main' });
    expect(res.target).toBe('main');
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(fs.existsSync(path.join(root, 'c.txt'))).toBe(true);
  });

  it('aborts and errors on merge conflicts instead of leaving a mess', async () => {
    const mgr = makeManager();
    const root = makeRepo();
    const { path: wtPath } = await mgr.add({ repoRoot: root, branch: 'feature/conflict' });
    fs.writeFileSync(path.join(wtPath, 'a.txt'), 'feature version\n');
    git(wtPath, 'add', '-A');
    git(wtPath, 'commit', '-qm', 'feature change');
    fs.writeFileSync(path.join(root, 'a.txt'), 'main version\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'main change');

    await expect(mgr.merge({ repoRoot: root, path: wtPath })).rejects.toThrow(/conflicts.*aborted/);
    // No merge left in progress.
    expect(() => git(root, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(root, 'status', '--porcelain').trim()).toBe('');
  });

  it('rejects non-git repoRoots', async () => {
    const mgr = makeManager();
    await expect(mgr.add({ repoRoot: makeScratch(), branch: 'x' })).rejects.toThrow(/not inside a git repository/);
    await expect(mgr.list('relative/path')).rejects.toThrow(/absolute/);
  });
});
