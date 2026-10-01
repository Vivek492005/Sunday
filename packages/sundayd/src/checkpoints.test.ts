// Tests for CheckpointManager: shadow-repo snapshots, list, restore.
// Uses temp git repos under os.tmpdir. No network.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointManager, workspaceKey } from './checkpoints.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeScratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-ckpt-test-'));
}

/** Temp git repo with one committed file. */
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
  const baseDir = makeScratch();
  return { mgr: new CheckpointManager(baseDir), baseDir };
}

describe('CheckpointManager', () => {
  it('creates a checkpoint and lists it with the label', async () => {
    const { mgr } = makeManager();
    const root = makeRepo();
    const created = await mgr.create({ workspaceRoot: root, label: 'before-refactor' });
    expect(created.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(created.id).toBe(created.sha);
    expect(new Date(created.createdAt).getTime()).not.toBeNaN();

    const { checkpoints } = await mgr.list(root);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].id).toBe(created.sha);
    expect(checkpoints[0].label).toBe('before-refactor');
  });

  it('keeps the shadow repo outside the workspace', async () => {
    const { mgr, baseDir } = makeManager();
    const root = makeRepo();
    await mgr.create({ workspaceRoot: root });
    const shadow = path.join(baseDir, workspaceKey(root), 'checkpoints.git');
    expect(fs.statSync(path.join(shadow, 'HEAD')).isFile()).toBe(true);
    // The user's own history is untouched — checkpointing added no commits there.
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
  });

  it('orders checkpoints newest-first', async () => {
    const { mgr } = makeManager();
    const root = makeRepo();
    const first = await mgr.create({ workspaceRoot: root, label: 'one' });
    fs.writeFileSync(path.join(root, 'a.txt'), 'v2\n');
    const second = await mgr.create({ workspaceRoot: root, label: 'two' });
    const { checkpoints } = await mgr.list(root);
    expect(checkpoints.map((c) => c.label)).toEqual(['two', 'one']);
    expect(checkpoints[0].id).toBe(second.sha);
    expect(checkpoints[1].id).toBe(first.sha);
  });

  it('restores file content and reports filesRestored', async () => {
    const { mgr } = makeManager();
    const root = makeRepo();
    const { sha } = await mgr.create({ workspaceRoot: root, label: 'good' });
    fs.writeFileSync(path.join(root, 'a.txt'), 'broken\n');
    fs.writeFileSync(path.join(root, 'new.txt'), 'untracked-after\n');

    const res = await mgr.restore({ workspaceRoot: root, id: sha });
    expect(res.sha).toBe(sha);
    expect(res.id).toBe(sha);
    expect(res.filesRestored).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('v1\n');
    // Files created after the checkpoint are left alone, not nuked.
    expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('untracked-after\n');
  });

  it('restores a deleted file', async () => {
    const { mgr } = makeManager();
    const root = makeRepo();
    const { sha } = await mgr.create({ workspaceRoot: root });
    fs.unlinkSync(path.join(root, 'a.txt'));
    const res = await mgr.restore({ workspaceRoot: root, id: sha });
    expect(res.filesRestored).toBe(1);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('v1\n');
  });

  it('snapshots non-git directories too', async () => {
    const { mgr } = makeManager();
    const root = makeScratch();
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello\n');
    const { sha } = await mgr.create({ workspaceRoot: root, label: 'plain' });
    fs.writeFileSync(path.join(root, 'note.txt'), 'changed\n');
    await mgr.restore({ workspaceRoot: root, id: sha });
    expect(fs.readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('hello\n');
    const { checkpoints } = await mgr.list(root);
    expect(checkpoints[0].label).toBe('plain');
  });

  it('returns an empty list when nothing was checkpointed', async () => {
    const { mgr } = makeManager();
    const { checkpoints } = await mgr.list(makeRepo());
    expect(checkpoints).toEqual([]);
  });

  it('rejects non-absolute workspace roots', async () => {
    const { mgr } = makeManager();
    await expect(mgr.create({ workspaceRoot: 'relative/path' })).rejects.toThrow(/absolute/);
    await expect(mgr.list('relative/path')).rejects.toThrow(/absolute/);
  });

  it('rejects unknown checkpoint ids on restore', async () => {
    const { mgr } = makeManager();
    const root = makeRepo();
    await mgr.create({ workspaceRoot: root });
    await expect(mgr.restore({ workspaceRoot: root, id: 'deadbeef' })).rejects.toThrow();
  });

  it('stores the session id in the checkpoint commit', async () => {
    const { mgr, baseDir } = makeManager();
    const root = makeRepo();
    const { sha } = await mgr.create({ workspaceRoot: root, sessionId: 'sess-42' });
    const shadow = path.join(baseDir, workspaceKey(root), 'checkpoints.git');
    const body = execFileSync('git', ['--git-dir', shadow, 'log', '-1', '--format=%B', sha], {
      encoding: 'utf8',
    });
    expect(body).toContain('session: sess-42');
  });
});
