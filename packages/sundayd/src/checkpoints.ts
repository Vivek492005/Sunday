import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// sundayd — CheckpointManager (§Phase 4).
//
// Snapshots the tracked-file state of a workspace into a *shadow* git repo at
// `~/.sunday/workspaces/<sha256(workspaceRoot)>/checkpoints.git` — never
// inside the user's repo, so checkpointing can't pollute their history, hooks,
// or remotes. The shadow repo is driven with `--git-dir`/`--work-tree` flags,
// which also makes non-git directories work with the same code path (the
// work-tree is snapshotted regardless of whether it contains a `.git`).
//
// Restore writes the checkpoint tree back into the workspace (modified and
// deleted tracked files). Files created *after* the checkpoint are left alone.

export function defaultWorkspacesDir(): string {
  return path.join(os.homedir(), '.sunday', 'workspaces');
}

/** Stable per-workspace key: sha256 of the resolved workspace root. */
export function workspaceKey(workspaceRoot: string): string {
  return createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex');
}

export interface CheckpointCreateParams {
  workspaceRoot: string;
  sessionId?: string;
  label?: string;
}

export interface CheckpointRecord {
  id: string;
  sha: string;
  label: string;
  createdAt: string;
}

export interface CheckpointRestoreResult {
  id: string;
  sha: string;
  filesRestored: number;
}

interface GitError extends Error {
  stderr?: string;
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        // Checkpoint commits must not pick up the user's global git identity
        // or system config surprises; identity is pinned per-invocation.
        GIT_CONFIG_NOSYSTEM: '1',
        // NOTE: os.devNull is '\\.\nul' on Windows, which Git for Windows
        // (MSYS2) cannot open — use the plain DOS device name there.
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
      },
    });
    return stdout;
  } catch (e) {
    const err = e as GitError;
    const detail = typeof err.stderr === 'string' && err.stderr.trim() ? `: ${err.stderr.trim()}` : '';
    throw new Error(`git ${args[0]} failed${detail}`);
  }
}

/** Validate the workspace root: absolute, exists, a directory, and never the
 *  shadow store itself. Returns the resolved path. */
async function assertWorkspaceRoot(workspaceRoot: string, baseDir: string): Promise<string> {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0 || !path.isAbsolute(workspaceRoot)) {
    throw new Error(`workspaceRoot must be an absolute path, got: ${String(workspaceRoot)}`);
  }
  const root = path.resolve(workspaceRoot);
  const base = path.resolve(baseDir);
  if (root === base || root.startsWith(base + path.sep)) {
    throw new Error(`workspaceRoot must not point inside the Sunday shadow store: ${root}`);
  }
  const st = await fs.stat(root).catch(() => undefined);
  if (!st?.isDirectory()) {
    throw new Error(`workspaceRoot is not a directory: ${root}`);
  }
  return root;
}

function sanitizeLabel(label: string | undefined): string {
  const clean = (label ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  return clean || 'checkpoint';
}

/** Parse `git log --format=%H%x00%s%x00%cI%x00%b%x1e` records. */
function parseLog(out: string): CheckpointRecord[] {
  const records: CheckpointRecord[] = [];
  for (const rec of out.split('\x1e')) {
    const t = rec.trim();
    if (!t) continue;
    const [sha = '', subject = '', createdAt = ''] = t.split('\x00');
    if (!sha) continue;
    const prefix = 'sunday checkpoint: ';
    const label = subject.startsWith(prefix) ? subject.slice(prefix.length) : subject;
    records.push({ id: sha, sha, label, createdAt });
  }
  return records;
}

/**
 * CheckpointManager — snapshot/restore/list workspace file state via a
 * shadow git repo. Construct with an explicit `baseDir` in tests; production
 * uses `~/.sunday/workspaces`.
 */
export class CheckpointManager {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly baseDir: string = defaultWorkspacesDir()) {}

  private shadowDir(root: string): string {
    return path.join(this.baseDir, workspaceKey(root), 'checkpoints.git');
  }

  /** Serialize mutating operations per workspace (git index is not
   *  concurrency-safe across processes, let alone concurrent calls). */
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next);
    // Drop the lock entry once the chain settles to avoid unbounded growth.
    // then(onF, onR) — not finally() — so this bookkeeping promise never
    // rejects (a finally() would fork an unhandled rejection on failure).
    const release = () => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    };
    void next.then(release, release);
    return next;
  }

  private async ensureShadowRepo(shadow: string): Promise<void> {
    // Owner-only (0700): the shadow repo is a full workspace snapshot via
    // `git add -A` — it WILL contain .env files, *.pem keys, etc. (Privacy H3).
    await fs.mkdir(shadow, { recursive: true, mode: 0o700 });
    const head = path.join(shadow, 'HEAD');
    try {
      await fs.access(head);
    } catch {
      await git(['init', '--bare', '-q', shadow]);
      // git init respects umask; enforce 0700 explicitly.
      await fs.chmod(shadow, 0o700).catch(() => undefined);
    }
  }

  async create(params: CheckpointCreateParams): Promise<{ id: string; sha: string; createdAt: string }> {
    const root = await assertWorkspaceRoot(params.workspaceRoot, this.baseDir);
    const shadow = this.shadowDir(root);
    return this.serialize(workspaceKey(root), async () => {
      await this.ensureShadowRepo(shadow);
      const label = sanitizeLabel(params.label);
      // Snapshot the work-tree into the shadow repo. `--git-dir`/`--work-tree`
      // keeps the user's own `.git` (if any) untouched — a nested `.git`
      // becomes a gitlink, never recursed into.
      await git(['--git-dir', shadow, '--work-tree', root, 'add', '-A'], root);
      const subject = `sunday checkpoint: ${label}`;
      const body = params.sessionId ? `\n\nsession: ${params.sessionId}` : '';
      await git([
        '--git-dir',
        shadow,
        '--work-tree',
        root,
        '-c',
        'user.name=sunday',
        '-c',
        'user.email=sunday@localhost',
        'commit',
        '--allow-empty',
        '-q',
        '-m',
        `${subject}${body}`,
      ]);
      const sha = (await git(['--git-dir', shadow, 'rev-parse', 'HEAD'])).trim();
      const createdAt = (await git(['--git-dir', shadow, 'log', '-1', '--format=%cI', sha])).trim();
      return { id: sha, sha, createdAt };
    });
  }

  async list(workspaceRoot: string): Promise<{ checkpoints: CheckpointRecord[] }> {
    const root = await assertWorkspaceRoot(workspaceRoot, this.baseDir);
    const shadow = this.shadowDir(root);
    try {
      await fs.access(path.join(shadow, 'HEAD'));
    } catch {
      return { checkpoints: [] };
    }
    const out = await git(['--git-dir', shadow, 'log', '--format=%H%x00%s%x00%cI%x00%b%x1e']);
    return { checkpoints: parseLog(out) };
  }

  async restore(params: { workspaceRoot: string; id: string }): Promise<CheckpointRestoreResult> {
    const root = await assertWorkspaceRoot(params.workspaceRoot, this.baseDir);
    const shadow = this.shadowDir(root);
    return this.serialize(workspaceKey(root), async () => {
      await this.ensureShadowRepo(shadow);
      // Resolve full/short sha (or any rev) to a commit in the shadow repo.
      const sha = (await git(['--git-dir', shadow, 'rev-parse', '--verify', `${params.id}^{commit}`])).trim();
      // Files that currently differ from the checkpoint — these are the ones
      // the restore will rewrite. `git diff <commit>` compares the work-tree
      // against the commit directly (index not involved). cwd=root so the
      // `.` pathspec resolves inside the work-tree.
      const diffOut = await git(
        ['--git-dir', shadow, '--work-tree', root, 'diff', '--name-only', '-z', sha, '--', '.'],
        root,
      );
      const filesRestored = diffOut.split('\0').filter((s) => s.length > 0).length;
      await git(['--git-dir', shadow, '--work-tree', root, 'read-tree', sha], root);
      await git(['--git-dir', shadow, '--work-tree', root, 'checkout-index', '-f', '-a', '-q'], root);
      return { id: sha, sha, filesRestored };
    });
  }
}
