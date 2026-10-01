import { execFile } from 'node:child_process';
import { resolveWithinRoot } from './paths.js';
import { err, type Tool } from './types.js';

/** Read-only git inspection tools (§7.5). Writes (commit/push) stay behind the
 *  policy gate in sundayd — the agent asks, the user approves. */

const MAX_DIFF_CHARS = 60_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 4_000_000, windowsHide: true }, (e, stdout, stderr) => {
      if (e) reject(new Error(`git ${args[0]} failed: ${stderr.trim() || (e as Error).message}`));
      else resolve(stdout);
    });
  });
}

export const gitStatusTool: Tool = {
  definition: {
    name: 'git_status',
    description: 'Show git status (branch + porcelain) for the repo containing path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path inside the repo (default ".").' },
      },
    },
  },
  async execute(rawArgs, ctx) {
    const args = rawArgs as { path?: string };
    const cwd = resolveWithinRoot(ctx.cwd, args.path ?? '.');
    try {
      // NOTE: -b always prints a `## branch` header, so "clean" means no
      // non-header lines — not empty output.
      const out = await git(cwd, ['status', '--porcelain=v1', '-b']);
      const lines = out.trim().split('\n').filter(Boolean);
      const branch = lines[0]?.startsWith('## ') ? lines[0].slice(3) : '';
      const changes = lines.filter((l) => !l.startsWith('## '));
      return { output: changes.length ? lines.join('\n') : `(clean on ${branch || 'unknown branch'})` };
    } catch (e) {
      return err((e as Error).message);
    }
  },
};

export const gitDiffTool: Tool = {
  definition: {
    name: 'git_diff',
    description: 'Show the working-tree diff (or staged diff with staged:true), optionally limited to a path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to limit the diff to.' },
        staged: { type: 'boolean', description: 'Diff staged changes instead of the working tree.' },
      },
    },
  },
  async execute(rawArgs, ctx) {
    const args = rawArgs as { path?: string; staged?: boolean };
    const cwd = resolveWithinRoot(ctx.cwd, args.path ?? '.');
    try {
      const argv = ['diff', '--no-color', ...(args.staged ? ['--staged'] : [])];
      if (args.path) argv.push('--', args.path);
      let out = await git(cwd, argv);
      let note = '';
      if (out.length > MAX_DIFF_CHARS) {
        out = out.slice(0, MAX_DIFF_CHARS);
        note = `\n…[truncated to ${MAX_DIFF_CHARS} chars]`;
      }
      return { output: (out.trim() || '(no diff)') + note };
    } catch (e) {
      return err((e as Error).message);
    }
  },
};

export const gitLogTool: Tool = {
  definition: {
    name: 'git_log',
    description: 'Show recent commit history for the repo containing path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path inside the repo (default ".").' },
        limit: { type: 'integer', description: 'Number of commits (default 10).', minimum: 1, maximum: 50 },
      },
    },
  },
  async execute(rawArgs, ctx) {
    const args = rawArgs as { path?: string; limit?: number };
    const cwd = resolveWithinRoot(ctx.cwd, args.path ?? '.');
    try {
      const out = await git(cwd, [
        'log',
        `--format=%h %ad %an %s`,
        '--date=short',
        '-n',
        String(args.limit ?? 10),
      ]);
      return { output: out.trim() || '(no commits)' };
    } catch (e) {
      return err((e as Error).message);
    }
  },
};
