import { execFile } from 'node:child_process';
import { err, type Tool, type ToolContext, type ToolResult } from './types.js';

/** PR automation tools (§7.6): `gh_pr_create` (DANGEROUS — commits, pushes,
 *  opens a PR; always approval-gated via the PolicyGate) and `gh_pr_review`
 *  (read-only — no approval needed).
 *
 *  Safety design:
 *  - `gh_pr_create` only commits ALREADY STAGED changes. It never auto-stages;
 *    with an empty index it refuses and tells the agent to stage first.
 *  - All subprocess calls use execFile with an argv array — no shell, so a
 *    hostile title/branch cannot inject commands.
 *  - When the `gh` CLI is missing, the tool falls back to the GitHub REST API
 *    via fetch, using a token from the `GITHUB_TOKEN` env var (the daemon-side
 *    secret convention, mirroring sundayd's EnvSecretResolver). With no token
 *    it errors with remediation steps instead of guessing.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

const defaultExec: ExecFn = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 8_000_000, windowsHide: true }, (e, stdout, stderr) => {
      const errAny = e as (Error & { code?: number | string }) | null;
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: typeof errAny?.code === 'number' ? errAny.code : e ? 1 : 0,
      });
    });
  });

/** `sunday/<slug>`: lowercase, non-alphanumerics collapse to '-', max 50 chars. */
export function slugifyBranchName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/-+$/, '');
  return slug || 'changes';
}

/** Valid PR references: a bare number, `owner/repo#123`, or a PR URL. */
export function isValidPrRef(pr: string): boolean {
  return /^(?:\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+)$/.test(
    pr.trim(),
  );
}

/** Extract owner/repo from a git remote URL (ssh or https). */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = url
    .trim()
    .match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\s*$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function ghAvailable(exec: ExecFn, cwd: string): Promise<boolean> {
  const r = await exec('gh', ['--version'], cwd);
  return r.exitCode === 0 && /gh version/i.test(r.stdout);
}

/** The commit message for the PR branch. `gh_pr_create` is a daemon-side
 *  tool, so it cannot use the ext-agent commit-message helper (that one is
 *  VS Code-bound); the title doubles as the conventional commit subject. */
export function commitMessageFor(title: string, body?: string): string {
  return body ? `${title}\n\n${body}` : title;
}

interface PrCreateDeps {
  exec?: ExecFn;
  /** Injected for tests; defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Injected for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export function createGhPrCreateTool(deps: PrCreateDeps = {}): Tool {
  const exec = deps.exec ?? defaultExec;
  const fetchFn = deps.fetchFn ?? fetch;
  const env = deps.env ?? process.env;

  return {
    definition: {
      name: 'gh_pr_create',
      description:
        'Create a GitHub pull request from already-STAGED changes. Commits staged changes (never auto-stages), creates branch sunday/<slug> when on main/master, pushes, and opens the PR. Requires user approval.',
      // P0: commits + pushes + opens a PR — always approval-gated.
      dangerous: true,
      parameters: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, description: 'PR title (also used as the commit subject).' },
          body: { type: 'string', description: 'PR body/description.' },
          base: { type: 'string', description: 'Base branch for the PR (default: repo default branch).' },
        },
      },
    },
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const args = rawArgs as { title: string; body?: string; base?: string };
      const title = args.title.trim();
      if (!title) return err('gh_pr_create: title must be non-empty');
      const body = args.body?.trim() || '';
      const base = args.base?.trim() || '';
      const cwd = ctx.cwd;

      // 1. Current branch.
      const branchRes = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      if (branchRes.exitCode !== 0) {
        return err(`gh_pr_create: not a git repo (or git failed): ${branchRes.stderr.trim()}`);
      }
      const currentBranch = branchRes.stdout.trim();

      // 2. Refuse when nothing is staged — never auto-stage.
      const stagedRes = await exec('git', ['diff', '--cached', '--quiet'], cwd);
      if (stagedRes.exitCode === 0) {
        return err(
          'gh_pr_create: nothing is staged — stage the changes you want in this PR first (e.g. `git add`). This tool never auto-stages.',
        );
      }

      // 3. Branch: create sunday/<slug> when on main/master.
      let branch = currentBranch;
      if (currentBranch === 'main' || currentBranch === 'master') {
        branch = `sunday/${slugifyBranchName(title)}`;
        const checkout = await exec('git', ['checkout', '-b', branch], cwd);
        if (checkout.exitCode !== 0) {
          return err(`gh_pr_create: could not create branch ${branch}: ${checkout.stderr.trim()}`);
        }
      }

      // 4. Commit the staged changes.
      const commit = await exec(
        'git',
        ['commit', '-m', commitMessageFor(title, body || undefined)],
        cwd,
      );
      if (commit.exitCode !== 0) {
        return err(`gh_pr_create: commit failed: ${commit.stderr.trim()}`);
      }

      // 5. Push.
      const push = await exec('git', ['push', '-u', 'origin', branch], cwd);
      if (push.exitCode !== 0) {
        return err(`gh_pr_create: push failed: ${push.stderr.trim()}`);
      }

      // 6. Open the PR — gh CLI preferred, REST fallback with env token.
      if (await ghAvailable(exec, cwd)) {
        const ghArgs = ['pr', 'create', '--title', title, '--body', body];
        if (base) ghArgs.push('--base', base);
        const pr = await exec('gh', ghArgs, cwd);
        if (pr.exitCode !== 0) {
          return err(`gh_pr_create: branch pushed but \`gh pr create\` failed: ${pr.stderr.trim()}`);
        }
        const url = pr.stdout.trim().split('\n').pop() ?? '';
        return {
          output: `PR created: ${url}`,
          metadata: { url, branch, via: 'gh-cli' },
        };
      }

      // Fallback: GitHub REST API via fetch.
      const token = env['GITHUB_TOKEN'];
      if (!token) {
        return err(
          'gh_pr_create: `gh` CLI not found and no GITHUB_TOKEN is set. ' +
            'Branch was pushed; finish manually with `gh pr create`, or set the GITHUB_TOKEN ' +
            'env var (daemon side) so this tool can use the GitHub API, or run `gh auth login`.',
        );
      }
      const remoteRes = await exec('git', ['remote', 'get-url', 'origin'], cwd);
      const remote = parseGitHubRemote(remoteRes.stdout);
      if (!remote) {
        return err(
          `gh_pr_create: \`gh\` CLI not found and origin is not a github.com remote (${remoteRes.stdout.trim() || 'no origin'}). Cannot create the PR via API.`,
        );
      }
      try {
        const res = await fetchFn(
          `https://api.github.com/repos/${remote.owner}/${remote.repo}/pulls`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ title, body, head: branch, base: base || undefined }),
          },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return err(
            `gh_pr_create: branch pushed but GitHub API returned ${res.status}: ${text.slice(0, 300)}`,
          );
        }
        const data = (await res.json()) as { html_url?: string; number?: number };
        const url = data.html_url ?? '';
        return {
          output: `PR created: ${url}`,
          metadata: { url, number: data.number, branch, via: 'github-api' },
        };
      } catch (e) {
        return err(`gh_pr_create: branch pushed but API request failed: ${(e as Error).message}`);
      }
    },
  };
}

interface ReviewComment {
  author: string;
  path?: string;
  line?: number;
  body: string;
  state?: string;
}

export function formatReviewComments(raw: {
  number?: number;
  title?: string;
  url?: string;
  reviews?: Array<{ author?: { login?: string }; state?: string; body?: string }>;
  comments?: Array<{ author?: { login?: string }; path?: string; line?: number; body?: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`PR #${raw.number ?? '?'}${raw.title ? ` — ${raw.title}` : ''}`);
  if (raw.url) lines.push(raw.url);
  const reviews = (raw.reviews ?? []).filter((r) => r.body?.trim());
  const comments = raw.comments ?? [];
  if (!reviews.length && !comments.length) {
    lines.push('No review comments yet.');
    return lines.join('\n');
  }
  lines.push('', '## Reviews');
  for (const r of reviews) {
    const author = r.author?.login ?? 'unknown';
    const state = r.state ? ` [${r.state}]` : '';
    lines.push(`- ${author}${state}: ${r.body!.trim().split('\n')[0]}`);
    const rest = r.body!.trim().split('\n').slice(1).join('\n').trim();
    if (rest) lines.push(`  ${rest}`);
  }
  lines.push('', '## Inline comments');
  for (const c of comments) {
    const author = c.author?.login ?? 'unknown';
    const loc = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : '';
    lines.push(`- ${author}${loc}: ${(c.body ?? '').trim().split('\n')[0]}`);
  }
  return lines.join('\n');
}

export function createGhPrReviewTool(deps: { exec?: ExecFn } = {}): Tool {
  const exec = deps.exec ?? defaultExec;
  return {
    definition: {
      name: 'gh_pr_review',
      description:
        'Read review comments on a GitHub pull request (reviews + inline comments), formatted as a structured list for the agent to address. Read-only.',
      // Read-only — safe, no approval needed.
      dangerous: false,
      parameters: {
        type: 'object',
        required: ['pr'],
        properties: {
          pr: {
            type: 'string',
            description: 'PR reference: number (e.g. "123"), "owner/repo#123", or full PR URL.',
          },
        },
      },
    },
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const args = rawArgs as { pr: string };
      const pr = (args.pr ?? '').trim();
      if (!isValidPrRef(pr)) {
        return err(
          `gh_pr_review: invalid PR reference "${pr}" — use a number ("123"), "owner/repo#123", or a full PR URL.`,
        );
      }
      if (!(await ghAvailable(exec, ctx.cwd))) {
        return err('gh_pr_review: `gh` CLI not found — install it and run `gh auth login`.');
      }
      const res = await exec(
        'gh',
        ['pr', 'view', pr, '--json', 'number,title,url,reviews,comments'],
        ctx.cwd,
      );
      if (res.exitCode !== 0) {
        return err(`gh_pr_review: \`gh pr view\` failed: ${res.stderr.trim()}`);
      }
      try {
        const data = JSON.parse(res.stdout) as Parameters<typeof formatReviewComments>[0];
        return { output: formatReviewComments(data), metadata: { pr } };
      } catch (e) {
        return err(`gh_pr_review: could not parse gh output: ${(e as Error).message}`);
      }
    },
  };
}

/** Ready-made instances with the real subprocess runner (registered by default). */
export const ghPrCreateTool: Tool = createGhPrCreateTool();
export const ghPrReviewTool: Tool = createGhPrReviewTool();
