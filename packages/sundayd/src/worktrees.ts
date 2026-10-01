import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// sundayd — WorktreeManager (§Phase 4).
//
// Thin, strict wrapper around `git worktree` for agent workspaces: add, list,
// remove, and merge a worktree branch back into a target branch. Merge never
// forces — on conflicts the merge is aborted and an error is returned, so the
// user's repo is never left mid-merge.

export function defaultWorktreesDir(): string {
  return path.join(os.homedir(), '.sunday', 'worktrees');
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

interface GitError extends Error {
  stderr?: string;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as GitError;
    const detail = typeof err.stderr === 'string' && err.stderr.trim() ? `: ${err.stderr.trim()}` : '';
    throw new Error(`git ${args[0]} failed${detail}`);
  }
}

/** Validate repoRoot: absolute, a directory, and the top level of a git repo. */
async function assertRepoRoot(repoRoot: string): Promise<string> {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0 || !path.isAbsolute(repoRoot)) {
    throw new Error(`repoRoot must be an absolute path, got: ${String(repoRoot)}`);
  }
  const root = path.resolve(repoRoot);
  const st = await fs.stat(root).catch(() => undefined);
  if (!st?.isDirectory()) {
    throw new Error(`repoRoot is not a directory: ${root}`);
  }
  let top: string;
  try {
    top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new Error(`repoRoot is not inside a git repository: ${root}`);
  }
  // Operate on the main worktree (the repo top level), not a nested worktree.
  return path.resolve(top);
}

async function checkBranchName(repoRoot: string, branch: string): Promise<void> {
  try {
    await git(repoRoot, ['check-ref-format', '--branch', branch]);
  } catch {
    throw new Error(`invalid branch name: ${branch}`);
  }
}

/** Parse `git worktree list --porcelain`. */
function parseWorktreeList(out: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  const flush = () => {
    if (cur.path && cur.head) {
      worktrees.push({ path: cur.path, branch: cur.branch ?? '', head: cur.head });
    }
    cur = {};
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      // Git prints forward slashes even on Windows; normalize to the
      // platform form so path comparisons behave.
      cur.path = path.normalize(line.slice('worktree '.length));
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      cur.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === 'detached') {
      cur.branch = '';
    } else if (line === '' && (cur.path || cur.head)) {
      flush();
    }
  }
  flush();
  return worktrees;
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  // Windows paths are case-insensitive (and git may report a different
  // drive-letter case than Node).
  return process.platform === 'win32'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

/**
 * WorktreeManager — agent workspaces as git worktrees. Default worktree
 * locations live under `~/.sunday/worktrees/<repo-key>/<branch>` so the
 * user's repo directory stays clean; an explicit `path` is honored as-is.
 */
export class WorktreeManager {
  constructor(private readonly baseDir: string = defaultWorktreesDir()) {}

  private defaultPath(repoRoot: string, branch: string): string {
    const key = createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 16);
    // `branch` already passed check-ref-format, so no `..` can sneak in.
    return path.join(this.baseDir, key, branch);
  }

  async add(params: { repoRoot: string; branch: string; path?: string }): Promise<{ path: string; branch: string }> {
    const root = await assertRepoRoot(params.repoRoot);
    await checkBranchName(root, params.branch);
    const wtPath = params.path ? path.resolve(params.path) : this.defaultPath(root, params.branch);
    // If the branch already exists locally, attach the worktree to it;
    // otherwise create it (`-b`).
    let exists = false;
    try {
      await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${params.branch}`]);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      await git(root, ['worktree', 'add', wtPath, params.branch]);
    } else {
      await git(root, ['worktree', 'add', '-b', params.branch, wtPath]);
    }
    return { path: wtPath, branch: params.branch };
  }

  async list(repoRoot: string): Promise<{ worktrees: WorktreeInfo[] }> {
    const root = await assertRepoRoot(repoRoot);
    const out = await git(root, ['worktree', 'list', '--porcelain']);
    return { worktrees: parseWorktreeList(out) };
  }

  async remove(params: { repoRoot: string; path: string; force?: boolean }): Promise<{ removed: true }> {
    const root = await assertRepoRoot(params.repoRoot);
    const target = path.resolve(params.path);
    // Refuse to remove anything that isn't a registered worktree of this
    // repo — `git worktree remove` on an arbitrary directory would be a
    // footgun.
    const { worktrees } = await this.list(root);
    if (!worktrees.some((w) => samePath(w.path, target))) {
      throw new Error(`not a registered worktree of ${root}: ${target}`);
    }
    // Never remove the main worktree itself.
    if (samePath(target, root)) {
      throw new Error(`refusing to remove the main worktree: ${target}`);
    }
    await git(root, ['worktree', 'remove', ...(params.force ? ['--force'] : []), target]);
    return { removed: true as const };
  }

  async merge(params: {
    repoRoot: string;
    path: string;
    target?: string;
  }): Promise<{ merged: true; sha: string; target: string }> {
    const root = await assertRepoRoot(params.repoRoot);
    const target = path.resolve(params.path);
    const { worktrees } = await this.list(root);
    const wt = worktrees.find((w) => samePath(w.path, target));
    if (!wt) {
      throw new Error(`not a registered worktree of ${root}: ${target}`);
    }
    if (!wt.branch) {
      throw new Error(`worktree is on a detached HEAD and cannot be merged: ${target}`);
    }
    const current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const tgt = params.target ?? current;
    if (tgt === 'HEAD') {
      throw new Error('repo is on a detached HEAD — pass an explicit target branch');
    }
    await checkBranchName(root, tgt);
    if (current !== tgt) {
      // Move the main worktree onto the target branch first. Fails loudly
      // when the worktree is dirty instead of clobbering user state.
      await git(root, ['checkout', tgt]);
    }
    try {
      await git(root, ['merge', '--no-ff', '--no-edit', '-m', `sunday: merge ${wt.branch} into ${tgt}`, wt.branch]);
    } catch (e) {
      // Never leave the repo mid-merge on conflicts.
      await git(root, ['merge', '--abort']).catch(() => undefined);
      throw new Error(`merge of ${wt.branch} into ${tgt} hit conflicts — aborted, no changes kept`);
    }
    const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
    return { merged: true as const, sha, target: tgt };
  }
}
