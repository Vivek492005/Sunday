import { describe, it, expect, vi } from 'vitest';
import {
  createGhPrCreateTool,
  createGhPrReviewTool,
  formatReviewComments,
  ghPrCreateTool,
  ghPrReviewTool,
  isValidPrRef,
  parseGitHubRemote,
  slugifyBranchName,
  type ExecFn,
  type ExecResult,
} from './pr.js';
import type { ToolContext } from './types.js';

const ctx: ToolContext = { cwd: '/repo' };

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}
function fail(stderr: string, exitCode = 1): ExecResult {
  return { stdout: '', stderr, exitCode };
}

/** Fake runner: keyed on the command line. */
function fakeRunner(handlers: Record<string, ExecResult | ((args: string[]) => ExecResult)>): ExecFn {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    const h = handlers[key] ?? handlers[cmd];
    if (!h) throw new Error(`unexpected command: ${key}`);
    return typeof h === 'function' ? h(args) : h;
  };
}

describe('slugifyBranchName', () => {
  it('slugifies titles', () => {
    expect(slugifyBranchName('Add Dark Mode!')).toBe('add-dark-mode');
    expect(slugifyBranchName('Fix: login crash (P0)')).toBe('fix-login-crash-p0');
  });
  it('collapses and trims dashes, caps length', () => {
    expect(slugifyBranchName('  ---a---b---  ')).toBe('a-b');
    expect(slugifyBranchName('x'.repeat(100))).toHaveLength(50);
  });
  it('falls back for empty-ish titles', () => {
    expect(slugifyBranchName('!!!')).toBe('changes');
  });
});

describe('isValidPrRef', () => {
  it('accepts numbers, owner#n, and URLs', () => {
    expect(isValidPrRef('123')).toBe(true);
    expect(isValidPrRef('octo/repo#123')).toBe(true);
    expect(isValidPrRef('https://github.com/octo/repo/pull/123')).toBe(true);
  });
  it('rejects junk', () => {
    expect(isValidPrRef('')).toBe(false);
    expect(isValidPrRef('abc')).toBe(false);
    expect(isValidPrRef('123abc')).toBe(false);
    expect(isValidPrRef('octo/repo')).toBe(false);
    expect(isValidPrRef('https://evil.com/x/pull/1')).toBe(false);
  });
});

describe('parseGitHubRemote', () => {
  it('parses ssh and https remotes', () => {
    expect(parseGitHubRemote('git@github.com:octo/repo.git')).toEqual({ owner: 'octo', repo: 'repo' });
    expect(parseGitHubRemote('https://github.com/octo/repo.git')).toEqual({ owner: 'octo', repo: 'repo' });
    expect(parseGitHubRemote('https://github.com/octo/repo')).toEqual({ owner: 'octo', repo: 'repo' });
  });
  it('rejects non-github remotes', () => {
    expect(parseGitHubRemote('git@gitlab.com:octo/repo.git')).toBeNull();
  });
});

describe('tool definitions', () => {
  it('gh_pr_create is marked dangerous (approval-gated)', () => {
    expect(ghPrCreateTool.definition.name).toBe('gh_pr_create');
    expect(ghPrCreateTool.definition.dangerous).toBe(true);
  });
  it('gh_pr_review is read-only (not dangerous)', () => {
    expect(ghPrReviewTool.definition.name).toBe('gh_pr_review');
    expect(ghPrReviewTool.definition.dangerous).toBe(false);
  });
});

describe('gh_pr_create', () => {
  const ghOk = { 'gh --version': ok('gh version 2.60.0\n') };

  it('validates title through the registry schema (minLength)', async () => {
    // Empty title must be rejected before any subprocess runs.
    const run = vi.fn(async () => ok());
    const tool = createGhPrCreateTool({ exec: run });
    const res = await tool.execute({ title: '   ' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/title must be non-empty/);
    expect(run).not.toHaveBeenCalled();
  });

  it('happy path: stages->branch->commit->push->pr create', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.60.0\n');
      if (cmd === 'git' && args[0] === 'rev-parse') return ok('main\n');
      if (cmd === 'git' && args[0] === 'diff') return fail('', 1); // staged changes exist
      if (cmd === 'git' && args[0] === 'checkout') return ok('');
      if (cmd === 'git' && args[0] === 'commit') return ok('[sunday/add-x abc123]');
      if (cmd === 'git' && args[0] === 'push') return ok('');
      if (cmd === 'gh' && args[0] === 'pr') return ok('https://github.com/octo/repo/pull/7\n');
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const res = await createGhPrCreateTool({ exec }).execute({ title: 'Add X', body: 'details' }, ctx);
    expect(res.isError).not.toBe(true);
    expect(res.output).toContain('https://github.com/octo/repo/pull/7');
    expect(calls).toContain('git checkout -b sunday/add-x');
    expect(res.metadata?.via).toBe('gh-cli');
  });

  it('keeps the current branch when not on main/master', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.60.0\n');
      if (cmd === 'git' && args[0] === 'rev-parse') return ok('feature/y\n');
      if (cmd === 'git' && args[0] === 'diff') return fail('', 1);
      if (cmd === 'git' && args[0] === 'commit') return ok('');
      if (cmd === 'git' && args[0] === 'push') return ok('');
      if (cmd === 'gh' && args[0] === 'pr') return ok('https://github.com/octo/repo/pull/8\n');
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const res = await createGhPrCreateTool({ exec }).execute({ title: 'Add X' }, ctx);
    expect(res.isError).not.toBe(true);
    expect(calls.some((c) => c.startsWith('git checkout'))).toBe(false);
    expect(calls).toContain('git push -u origin feature/y');
  });

  it('refuses when nothing is staged (never auto-stages)', async () => {
    const exec = fakeRunner({
      ...ghOk,
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git diff --cached --quiet': ok(''), // exit 0 => clean index => nothing staged
    });
    const res = await createGhPrCreateTool({ exec }).execute({ title: 'Add X' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/nothing is staged/);
  });

  it('falls back to the GitHub API when gh is missing (token set)', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ html_url: 'https://github.com/octo/repo/pull/9', number: 9 }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const exec = fakeRunner({
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git diff --cached --quiet': fail('', 1),
      'git checkout -b sunday/add-x': ok(''),
      'git commit -m Add X': ok(''),
      'git push -u origin sunday/add-x': ok(''),
      'git remote get-url origin': ok('git@github.com:octo/repo.git\n'),
    });
    const res = await createGhPrCreateTool({
      exec: async (cmd, args, cwd) => {
        if (cmd === 'gh') return fail('command not found', 127);
        return exec(cmd, args, cwd);
      },
      fetchFn: fetchFn as unknown as typeof fetch,
      env: { GITHUB_TOKEN: 'tok' } as NodeJS.ProcessEnv,
    }).execute({ title: 'Add X' }, ctx);
    expect(res.isError).not.toBe(true);
    expect(res.output).toContain('https://github.com/octo/repo/pull/9');
    expect(res.metadata?.via).toBe('github-api');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('errors with remediation when gh is missing and no token', async () => {
    const exec = fakeRunner({
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git diff --cached --quiet': fail('', 1),
      'git checkout -b sunday/add-x': ok(''),
      'git commit -m Add X': ok(''),
      'git push -u origin sunday/add-x': ok(''),
    });
    const res = await createGhPrCreateTool({
      exec: async (cmd, args, cwd) => {
        if (cmd === 'gh') return fail('command not found', 127);
        return exec(cmd, args, cwd);
      },
      fetchFn: vi.fn(),
      env: {} as NodeJS.ProcessEnv,
    }).execute({ title: 'Add X' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/gh auth login/);
  });
});

describe('gh_pr_review', () => {
  const viewPayload = {
    number: 42,
    title: 'Add X',
    url: 'https://github.com/octo/repo/pull/42',
    reviews: [
      { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: 'Rename this var\nIt is confusing.' },
      { author: { login: 'bot' }, state: 'APPROVED', body: '' },
    ],
    comments: [{ author: { login: 'alice' }, path: 'src/a.ts', line: 10, body: 'nit: semicolon' }],
  };

  it('rejects invalid PR references', async () => {
    const run = vi.fn(async () => ok());
    const res = await createGhPrReviewTool({ exec: run }).execute({ pr: 'not-a-pr' }, ctx);
    expect(res.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('formats reviews and inline comments', async () => {
    const exec = fakeRunner({
      'gh --version': ok('gh version 2.60.0\n'),
      gh: ok(JSON.stringify(viewPayload)),
    });
    const res = await createGhPrReviewTool({ exec }).execute({ pr: '42' }, ctx);
    expect(res.isError).not.toBe(true);
    expect(res.output).toContain('PR #42 — Add X');
    expect(res.output).toContain('alice [CHANGES_REQUESTED]: Rename this var');
    expect(res.output).toContain('src/a.ts:10');
    expect(res.output).not.toContain('bot'); // empty-body reviews filtered
  });

  it('handles a PR with no comments', () => {
    const out = formatReviewComments({ number: 1, reviews: [], comments: [] });
    expect(out).toMatch(/No review comments yet/);
  });

  it('errors when gh is missing', async () => {
    const exec: ExecFn = async (cmd) => (cmd === 'gh' ? fail('not found', 127) : ok());
    const res = await createGhPrReviewTool({ exec }).execute({ pr: '42' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/gh.*not found/);
  });
});
