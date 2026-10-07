// sunday-agent — `sunday.git.commitMessage` (Part B, Worker 3).
//
// Generates a conventional-commit message from the staged diff and inserts
// it into the SCM input box.
//
// Diff source: the `vscode.git` extension API (`repository.diff(true)` for
// the staged diff) when the built-in git extension is present; otherwise a
// `git diff --cached` fallback via `cp.execFile` in the workspace folder.
// Unlike the code actions, this command NEEDS the model's text back, so it
// uses AgentSender.sendAndCollect and then strips fences from the reply
// before writing it to `repository.inputBox.value`.
//
// Pure, unit-tested helpers: truncateDiff, buildCommitPrompt,
// extractCommitMessage. getStagedDiff takes injectable seams so tests cover
// the git-extension-present and git-extension-absent paths without a real
// VS Code or a real repo.
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentSender, type AgentSendDeps } from './agentSend.js';
import { redactSecrets } from '@sunday/protocol'; // S6: redact secrets from outbound prompts

/** Staged diffs are capped so the prompt stays bounded. */
export const STAGED_DIFF_MAX_CHARS = 8000;

/** Fast, free-tier model ref for the one-shot commit-message turn. */
export const COMMIT_MODEL = 'groq:llama-3.1-8b-instant';

export interface Truncated {
  text: string;
  truncated: boolean;
}

/** Truncate a diff to the char budget (keeps the head — file headers first). */
export function truncateDiff(diff: string, maxChars = STAGED_DIFF_MAX_CHARS): Truncated {
  if (diff.length <= maxChars) return { text: diff, truncated: false };
  return {
    text: diff.slice(0, maxChars) + `\n…[diff truncated: ${diff.length - maxChars} more chars]`,
    truncated: true,
  };
}

/** Prompt: write a conventional-commit message for this staged diff. */
export function buildCommitPrompt(diff: string, truncated: boolean): string {
  return [
    'Write a conventional-commit message for the staged diff below.',
    'Rules: `<type>(<scope>): <subject>` on the first line, subject ≤ 72 chars, imperative mood.',
    'Add a short body only if the change needs explanation. Output ONLY the commit message — no code fences, no commentary.',
    truncated ? '(Note: the diff was truncated to fit; base the message on what is shown.)' : '',
    '',
    '```diff',
    redactSecrets(diff),
    '```',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * Extract the commit message from a model reply: strip ``` fences (with or
 * without a language tag), drop empty lines at the edges. Keeps multi-line
 * messages (subject + body) intact.
 */
export function extractCommitMessage(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    const firstNl = t.indexOf('\n');
    t = firstNl >= 0 ? t.slice(firstNl + 1) : '';
    const lastFence = t.lastIndexOf('```');
    if (lastFence >= 0) t = t.slice(0, lastFence);
  }
  return t.trim();
}

// -- git access seams -----------------------------------------------------------

/** Minimal shape of the vscode.git extension API we rely on. */
export interface GitRepositoryLike {
  diff(staged: boolean): Promise<string>;
  inputBox: { value: string };
  rootUri?: { fsPath: string };
}

export interface GitApiLike {
  repositories: GitRepositoryLike[];
}

export type GetGitExtension = () => { exports?: { getAPI(version: 1): GitApiLike | undefined } } | undefined;

/** Find the vscode.git repository for the workspace (or the first one). */
export function findGitRepository(
  getExtension: GetGitExtension,
  workspaceFolder?: string,
): GitRepositoryLike | undefined {
  try {
    const api = getExtension()?.exports?.getAPI(1);
    const repos = api?.repositories ?? [];
    if (!repos.length) return undefined;
    if (workspaceFolder) {
      const match = repos.find((r) => r.rootUri?.fsPath === workspaceFolder);
      if (match) return match;
    }
    return repos[0];
  } catch {
    return undefined;
  }
}

const execFileAsync = promisify(execFile);

/** Default `git diff --cached` fallback. Never throws empty-handed on purpose:
 *  callers treat a thrown error as "no diff available". */
export async function execGitDiffCached(workspaceFolder: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['diff', '--cached', '--no-color'], {
    cwd: workspaceFolder,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export interface StagedDiff {
  diff: string;
  via: 'git-extension' | 'cli-fallback';
}

/**
 * Get the staged diff: vscode.git API first, `git diff --cached` fallback.
 * Throws when neither source can produce one.
 */
export async function getStagedDiff(opts: {
  getExtension: GetGitExtension;
  workspaceFolder?: string;
  execGitDiff?: (cwd: string) => Promise<string>;
}): Promise<StagedDiff> {
  const repo = findGitRepository(opts.getExtension, opts.workspaceFolder);
  if (repo) {
    try {
      const diff = await repo.diff(true);
      return { diff, via: 'git-extension' };
    } catch {
      /* fall through to CLI */
    }
  }
  if (!opts.workspaceFolder) throw new Error('no workspace folder for git fallback');
  const execGitDiff = opts.execGitDiff ?? execGitDiffCached;
  const diff = await execGitDiff(opts.workspaceFolder);
  return { diff, via: 'cli-fallback' };
}

// -- command registration -------------------------------------------------------

export interface GitCommitDeps extends AgentSendDeps {
  /** Injectable for tests; defaults to the real `git diff --cached`. */
  execGitDiff?: (cwd: string) => Promise<string>;
  /** Injectable for tests; defaults to vscode.extensions.getExtension. */
  getGitExtension?: GetGitExtension;
}

export function registerGitCommitMessage(
  context: vscode.ExtensionContext,
  deps: GitCommitDeps,
): void {
  const sender = new AgentSender(deps);
  const getExtension: GetGitExtension =
    deps.getGitExtension ?? (() => vscode.extensions.getExtension('vscode.git'));

  context.subscriptions.push(
    vscode.commands.registerCommand('sunday.git.commitMessage', async () => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let staged: StagedDiff;
      try {
        staged = await getStagedDiff({ getExtension, workspaceFolder: wsFolder, execGitDiff: deps.execGitDiff });
      } catch (err) {
        vscode.window.showErrorMessage(`Sunday: could not read the staged diff: ${(err as Error).message}`);
        return;
      }
      if (!staged.diff.trim()) {
        vscode.window.showInformationMessage('Sunday: nothing staged — stage changes first, then generate a commit message.');
        return;
      }
      const { text, truncated } = truncateDiff(staged.diff);
      deps.log(`commitMessage: staged diff via ${staged.via} (${staged.diff.length} chars)`);
      let turn;
      try {
        turn = await sender.sendAndCollect(buildCommitPrompt(text, truncated), COMMIT_MODEL);
      } catch (err) {
        vscode.window.showErrorMessage(`Sunday: commit message generation failed: ${(err as Error).message}`);
        return;
      }
      if (!turn.ok || !turn.text?.trim()) {
        vscode.window.showErrorMessage(
          `Sunday: commit message generation failed: ${turn.error ?? 'empty reply'}`,
        );
        return;
      }
      const message = extractCommitMessage(turn.text);
      const repo = findGitRepository(getExtension, wsFolder);
      if (!repo?.inputBox) {
        vscode.window.showErrorMessage(
          'Sunday: generated a message but could not reach the SCM input box (vscode.git unavailable).',
        );
        deps.log(`commitMessage: no inputBox; generated message was: ${message}`);
        return;
      }
      repo.inputBox.value = message;
      vscode.window.showInformationMessage('Sunday: commit message inserted into the SCM input box.');
    }),
  );
}
