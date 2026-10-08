// sunday-agent — GitHub repo import.
//
// Lets the user sign in with GitHub (via the built-in `github` authentication
// provider, which does the OAuth Device Flow) and clone any of their repos
// directly into the IDE — no manual git clone in a terminal needed.
//
// Design notes:
//   - We deliberately use the BUILT-IN `github` auth provider instead of
//     registering our own: VS Code's github-authentication extension already
//     implements the Device Flow correctly, and a second provider with the
//     same id would conflict with it (and break the built-in GitHub PR/Issues
//     extension that depends on it).
//   - The access token is placed in the clone URL (`https://<token>@github.com/…`)
//     so private repos clone without extra credential setup. The token is
//     never logged — see `buildCloneUrl` (pure, unit-tested).
//   - Test boundary: everything that formats, parses, or decides lives in the
//     pure functions below (unit-tested in githubRepos.test.ts). Only
//     `registerGitHubCommands` touches the real `vscode` API.
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';

/** Auth provider id of the built-in VS Code GitHub authentication extension. */
export const GITHUB_PROVIDER_ID = 'github';
/** Scopes: identity + email + repo (repo enables cloning private repos). */
export const GITHUB_SCOPES: readonly string[] = ['read:user', 'user:email', 'repo'];
/** Command ids. */
export const GITHUB_SIGN_IN_COMMAND = 'sunday.github.signIn';
export const GITHUB_CLONE_REPO_COMMAND = 'sunday.github.cloneRepo';
export const GITHUB_SIGN_OUT_COMMAND = 'sunday.github.signOut';

/** Minimal shape of a GitHub repo from `GET /user/repos`. */
export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  updated_at: string;
  default_branch: string;
  clone_url: string;
}

/** QuickPick row for a repo. */
export interface RepoPickItem extends vscode.QuickPickItem {
  repo: GitHubRepo;
}

/**
 * Build the authenticated clone URL. The token is embedded so `git clone`
 * works without credential helpers. NEVER log the result — the token is a
 * secret. (Pure — the only place the token touches a URL.)
 */
export function buildCloneUrl(repo: GitHubRepo, token: string): string {
  // Use the https URL form; strip any existing credentials just in case.
  const url = repo.clone_url.replace(/^https:\/\/[^@]+@/, 'https://');
  return url.replace(/^https:\/\//, `https://${encodeURIComponent(token)}@`);
}

/** Human label for a repo pick row, e.g. `octocat/hello-world`. */
export function repoPickLabel(repo: GitHubRepo): string {
  return `$(${repo.private ? 'lock' : 'repo'}) ${repo.full_name}`;
}

/** Human detail line: description + last-updated date. */
export function repoPickDetail(repo: GitHubRepo): string {
  const desc = repo.description?.trim() || 'No description';
  let updated = repo.updated_at;
  const parsed = new Date(repo.updated_at);
  if (!Number.isNaN(parsed.getTime())) {
    updated = parsed.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return `${desc} — updated ${updated}`;
}

/** Default clone destination: `~/Sunday-repos/<repo-name>`. */
export function defaultCloneDir(repoName: string): string {
  return path.join(os.homedir(), 'Sunday-repos', repoName);
}

/** Classify a GitHub API failure for user messaging. */
export type GitHubApiErrorKind = 'auth' | 'rate-limit' | 'network' | 'unknown';

export function classifyApiError(status: number | undefined, err: unknown): GitHubApiErrorKind {
  if (status === 401 || status === 403) {
    // 403 can also be rate limiting — check the message.
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (/rate limit/i.test(msg)) return 'rate-limit';
    return 'auth';
  }
  if (status === 429) return 'rate-limit';
  if (err instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|aborted/i.test(err.message)) {
    return 'network';
  }
  return 'unknown';
}

/** User-facing message for a classified API error. */
export function apiErrorMessage(kind: GitHubApiErrorKind): string {
  switch (kind) {
    case 'auth':
      return 'GitHub authentication failed or expired. Please sign in again.';
    case 'rate-limit':
      return 'GitHub API rate limit reached. Please wait a few minutes and try again.';
    case 'network':
      return 'Could not reach github.com. Check your network connection.';
    default:
      return 'GitHub request failed. Please try again.';
  }
}

// -- GitHub API (injectable fetch for tests) -------------------------------------

export interface GitHubApiDeps {
  fetchImpl?: typeof fetch;
}

/** Fetch one page of the user's repos. Throws on non-2xx with `status` attached. */
export async function fetchUserReposPage(
  token: string,
  page: number,
  deps: GitHubApiDeps = {},
): Promise<GitHubRepo[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url =
    `https://api.github.com/user/repos?per_page=100&page=${page}` +
    `&sort=updated&direction=desc`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'sunday-ide',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (err) {
    const e = new Error(`GitHub API network error: ${(err as Error).message}`);
    (e as unknown as { status?: number }).status = undefined;
    throw e;
  }
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    const text = await res.text().catch(() => '');
    const kind = classifyApiError(res.status, new Error(text));
    const e = new Error(apiErrorMessage(kind));
    (e as unknown as { status?: number }).status = res.status;
    (e as unknown as { kind?: GitHubApiErrorKind }).kind = kind;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`GitHub API error (HTTP ${res.status})`);
    (e as unknown as { status?: number }).status = res.status;
    throw e;
  }
  const body = (await res.json()) as GitHubRepo[];
  if (!Array.isArray(body)) throw new Error('GitHub API: unexpected response shape');
  return body;
}

/** Fetch all pages of the user's repos (stops at the first short page). */
export async function fetchAllUserRepos(
  token: string,
  deps: GitHubApiDeps = {},
): Promise<GitHubRepo[]> {
  const all: GitHubRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await fetchUserReposPage(token, page, deps);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Fetch the authenticated user's login name (for the clone progress message). */
export async function fetchViewerLogin(
  token: string,
  deps: GitHubApiDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'sunday-ide',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API error (HTTP ${res.status})`);
  const body = (await res.json()) as { login?: string };
  return body.login ?? 'github-user';
}

// -- vscode wiring (thin shell) ---------------------------------------------------

export interface GitHubReposDeps {
  log?: (msg: string) => void;
}

interface CloneResult {
  ok: boolean;
  dir: string;
  error?: string;
}

/** Run `git clone` with progress reporting. Never logs the URL (contains token). */
function cloneRepo(
  cloneUrl: string,
  dir: string,
  progress: vscode.Progress<{ message?: string }>,
  token: { isCancellationRequested: boolean },
): Promise<CloneResult> {
  return new Promise((resolve) => {
    // `--progress` gives stderr updates; we surface a static message instead
    // of parsing the machine-unfriendly progress stream.
    const child = cp.spawn('git', ['clone', '--progress', cloneUrl, dir], {
      // Hide the token from any process listing that might capture argv.
      // (argv still visible to the local user; acceptable for a desktop app.)
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (token.isCancellationRequested) child.kill();
    });
    child.on('error', (err) => {
      resolve({ ok: false, dir, error: `Could not start git: ${err.message}` });
    });
    child.on('close', (code) => {
      if (token.isCancellationRequested) {
        resolve({ ok: false, dir, error: 'Clone cancelled.' });
      } else if (code === 0) {
        resolve({ ok: true, dir });
      } else {
        // Scrub any accidental token echo from git's stderr.
        const scrubbed = stderr.replace(/https:\/\/[^@\s]+@/g, 'https://***@');
        const firstLine = scrubbed.split('\n').filter(Boolean)[0] ?? `git exited with code ${code}`;
        resolve({ ok: false, dir, error: firstLine.slice(0, 300) });
      }
    });
    progress.report({ message: 'Cloning…' });
  });
}

async function getGitHubSession(
  createIfNone: boolean,
): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession(GITHUB_PROVIDER_ID, [...GITHUB_SCOPES], {
      createIfNone,
    });
  } catch {
    // Provider not available (e.g. upstream VS Code without the bundled
    // github-authentication extension) — treat as unavailable.
    return undefined;
  }
}

/** Register `sunday.github.signIn`, `sunday.github.signOut`, `sunday.github.cloneRepo`. */
export function registerGitHubCommands(
  context: vscode.ExtensionContext,
  deps: GitHubReposDeps = {},
): vscode.Disposable {
  const log = deps.log ?? (() => undefined);
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand(GITHUB_SIGN_IN_COMMAND, async () => {
      const session = await getGitHubSession(true);
      if (session) {
        void vscode.window.showInformationMessage(
          `Signed in to GitHub as ${session.account.label}.`,
        );
      } else {
        void vscode.window.showWarningMessage(
          'GitHub sign-in is not available in this build (missing GitHub authentication provider).',
        );
      }
    }),
  );

  disposables.push(
    vscode.commands.registerCommand(GITHUB_SIGN_OUT_COMMAND, async () => {
      // `vscode.authentication` has no public session-removal API; direct the
      // user to the Accounts menu, matching the Google sign-out fallback.
      void vscode.window.showInformationMessage(
        'Use the Accounts menu (bottom-left) to sign out of GitHub.',
      );
    }),
  );

  disposables.push(
    vscode.commands.registerCommand(GITHUB_CLONE_REPO_COMMAND, async () => {
      // 1. Session (triggers the Device Flow sign-in when needed).
      const session = await getGitHubSession(true);
      if (!session) {
        void vscode.window.showErrorMessage(
          'GitHub sign-in failed or is unavailable. ' +
            'Make sure the GitHub authentication provider is installed.',
        );
        return;
      }
      const token = session.accessToken;

      // 2. List repos with a cancellable progress notification.
      let repos: GitHubRepo[];
      try {
        repos = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Fetching your GitHub repositories…',
            cancellable: true,
          },
          async (_progress, cancel) => {
            const all = await fetchAllUserRepos(token);
            if (cancel.isCancellationRequested) throw new Error('cancelled');
            return all;
          },
        );
      } catch (err) {
        const message = (err as Error).message;
        if (message === 'cancelled') return;
        const kind = (err as { kind?: GitHubApiErrorKind }).kind
          ?? classifyApiError((err as { status?: number }).status, err);
        log(`github: repo list failed: ${message}`);
        void vscode.window.showErrorMessage(`Could not list GitHub repositories: ${apiErrorMessage(kind)}`);
        return;
      }

      if (repos.length === 0) {
        void vscode.window.showInformationMessage(
          'No GitHub repositories found for this account.',
        );
        return;
      }

      // 3. Pick a repo.
      const pick = await vscode.window.showQuickPick<RepoPickItem>(
        repos.map((repo) => ({
          repo,
          label: repoPickLabel(repo),
          description: repo.private ? 'private' : 'public',
          detail: repoPickDetail(repo),
        })),
        {
          title: 'Clone GitHub repository',
          placeHolder: `Choose from ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`,
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (!pick) return;
      const repo = pick.repo;

      // 4. Destination folder.
      const defaultDir = defaultCloneDir(repo.name);
      const dirInput = await vscode.window.showInputBox({
        title: `Clone ${repo.full_name}`,
        prompt: 'Local folder for the clone',
        value: defaultDir,
        validateInput: (v) => (v.trim() ? undefined : 'Folder path is required.'),
      });
      if (!dirInput) return;
      const dir = dirInput.trim();

      // 5. Clone with progress. The token never appears in logs or messages.
      const cloneUrl = buildCloneUrl(repo, token);
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cloning ${repo.full_name}…`,
          cancellable: true,
        },
        (progress, cancel) => cloneRepo(cloneUrl, dir, progress, cancel),
      );

      if (!result.ok) {
        void vscode.window.showErrorMessage(`Clone failed: ${result.error}`);
        return;
      }

      // 6. Offer to open.
      const open = await vscode.window.showInformationMessage(
        `Cloned ${repo.full_name} to ${result.dir}.`,
        'Open in New Window',
      );
      if (open === 'Open in New Window') {
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(result.dir),
          true,
        );
      }
    }),
  );

  return vscode.Disposable.from(...disposables);
}
