// sunday-agent — best-of-N comparison view (Group A, A2).
//
// `sunday.bestOfN.run`: prompts for a goal + attempt count, runs N parallel
// variants through sundayd (`bestofn/run`), then opens a comparison panel:
// side-by-side cards with diff previews and a "Pick winner" button. Picking
// applies that attempt's worktree via the existing `worktree/merge`.
//
// vscode-coupled by design; covered by bestOfNView.test.ts with a mocked
// `vscode` module and a stub HostBridge.
import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';
import type { BestofnAttempt } from '@sunday/protocol';

export const BEST_OF_N_RUN_COMMAND = 'sunday.bestOfN.run';

export interface BestOfNViewDeps {
  getBridge: () => Promise<HostBridge | undefined>;
  getCwd: () => string | undefined;
  log: (msg: string) => void;
}

/** HTML-escape untrusted attempt content (summaries, diffs). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DIFF_PREVIEW_CHARS = 4000;

function attemptCard(a: BestofnAttempt, index: number): string {
  const failed = !!a.error;
  const diffPreview = a.diff
    ? escapeHtml(a.diff.slice(0, DIFF_PREVIEW_CHARS)) + (a.diff.length > DIFF_PREVIEW_CHARS ? '\n… (truncated)' : '')
    : '<em>No changes</em>';
  const files = a.filesChanged.length
    ? `<div class="files">${a.filesChanged.map((f) => `<code>${escapeHtml(f)}</code>`).join(' ')}</div>`
    : '';
  return `
  <div class="card${failed ? ' failed' : ''}" data-index="${index}">
    <div class="card-header">
      <strong>${escapeHtml(a.id)}</strong>
      <span class="badge">${escapeHtml(a.angle)}</span>
      <span class="badge">t=${a.temperature}</span>
      ${failed ? '<span class="badge error">failed</span>' : ''}
    </div>
    <p class="summary">${failed ? escapeHtml(a.error ?? 'unknown error') : escapeHtml(a.summary || '(no summary)')}</p>
    ${files}
    <pre class="diff">${diffPreview}</pre>
    <button class="pick" data-pick="${index}" ${failed ? 'disabled' : ''}>Pick winner</button>
  </div>`;
}

/** Pure HTML builder (unit-tested). */
export function renderBestOfNHtml(goal: string, attempts: BestofnAttempt[]): string {
  const cards = attempts.map((a, i) => attemptCard(a, i)).join('\n');
  const empty = attempts.length === 0
    ? '<p class="empty">No attempts were produced.</p>'
    : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
  h1 { font-size: 1.2em; } .goal { opacity: .8; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; }
  .card.failed { opacity: .75; border-color: var(--vscode-errorForeground); }
  .card-header { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
           border-radius: 4px; padding: 1px 8px; font-size: .8em; }
  .badge.error { background: var(--vscode-errorForeground); color: #fff; }
  .summary { white-space: pre-wrap; }
  .files { margin: 8px 0; } .files code { margin-right: 6px; font-size: .85em; }
  pre.diff { max-height: 320px; overflow: auto; background: var(--vscode-textCodeBlock-background);
             padding: 8px; border-radius: 4px; font-size: .8em; }
  button.pick { margin-top: 8px; }
  .empty { opacity: .7; }
</style></head>
<body>
  <h1>Best-of-N comparison</h1>
  <div class="goal">Goal: ${escapeHtml(goal)}</div>
  ${empty}
  <div class="grid">${cards}</div>
  <script>
    const vscodeApi = acquireVsCodeApi();
    document.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscodeApi.postMessage({ command: 'pickWinner', index: Number(btn.getAttribute('data-pick')) });
      });
    });
  </script>
</body></html>`;
}

/** Validate a winner pick (mirrors the orchestrator's pickWinner backstop). */
export function validateWinnerPick(attempts: BestofnAttempt[], index: number): BestofnAttempt {
  if (!Number.isInteger(index) || index < 0 || index >= attempts.length) {
    throw new Error(`pickWinner: index ${index} out of range`);
  }
  const winner = attempts[index]!;
  if (winner.error) throw new Error(`pickWinner: ${winner.id} failed`);
  if (!winner.worktree) throw new Error(`pickWinner: ${winner.id} has no worktree to merge`);
  return winner;
}

class BestOfNPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly deps: BestOfNViewDeps) {}

  show(goal: string, workdir: string, attempts: BestofnAttempt[]): void {
    if (this.panel) {
      this.panel.dispose();
    }
    this.panel = vscode.window.createWebviewPanel(
      'sunday.bestOfNView',
      'Sunday: Best-of-N',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = renderBestOfNHtml(goal, attempts);
    this.panel.webview.onDidReceiveMessage(
      (msg: unknown) => {
        void this.onMessage(msg, workdir, attempts).catch((err: Error) =>
          vscode.window.showErrorMessage(`Best-of-N failed: ${err.message}`),
        );
      },
      undefined,
      [],
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private async onMessage(msg: unknown, workdir: string, attempts: BestofnAttempt[]): Promise<void> {
    const m = msg as { command?: string; index?: number };
    if (m?.command !== 'pickWinner' || typeof m.index !== 'number') return;
    const winner = validateWinnerPick(attempts, m.index);
    const bridge = await this.deps.getBridge();
    if (!bridge) {
      vscode.window.showErrorMessage('Sunday sidecar is not running.');
      return;
    }
    this.deps.log(`best-of-n: merging winner ${winner.id} (${winner.branch})`);
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Merging ${winner.id}…`, cancellable: false },
      () => bridge.worktreeMerge({ repoRoot: workdir, path: winner.worktree }),
    );
    vscode.window.showInformationMessage(
      `Best-of-N winner ${winner.id} merged (${res.sha.slice(0, 12)} into ${res.target}).`,
    );
    this.panel?.dispose();
  }
}

export function registerBestOfN(
  context: vscode.ExtensionContext,
  deps: BestOfNViewDeps,
): void {
  const panel = new BestOfNPanel(deps);
  context.subscriptions.push(
    vscode.commands.registerCommand(BEST_OF_N_RUN_COMMAND, async () => {
      const goal = await vscode.window.showInputBox({
        title: 'Sunday: Best-of-N',
        prompt: 'Goal for the parallel attempts (each runs in its own worktree)',
        placeHolder: 'e.g. Add input validation to the signup form',
        validateInput: (v) => (v.trim() ? undefined : 'Enter a goal.'),
      });
      if (!goal) return;
      const workdir = deps.getCwd();
      if (!workdir) {
        vscode.window.showErrorMessage('Best-of-N needs an open workspace folder (a git repo).');
        return;
      }
      const countPick = await vscode.window.showQuickPick(['2', '3', '4', '5'], {
        title: 'Sunday: Best-of-N',
        placeHolder: 'How many parallel attempts?',
      });
      if (!countPick) return;
      const bridge = await deps.getBridge();
      if (!bridge) return;
      deps.log(`best-of-n: run requested (${countPick} attempts) for "${goal.trim().slice(0, 80)}"`);
      try {
        const { attempts } = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Sunday: running ${countPick} parallel attempts…`,
            cancellable: false,
          },
          () => bridge.bestofnRun({ goal: goal.trim(), attempts: Number(countPick), workdir }),
        );
        panel.show(goal.trim(), workdir, attempts);
        const succeeded = attempts.filter((a) => !a.error).length;
        deps.log(`best-of-n: ${succeeded}/${attempts.length} attempts produced diffs`);
      } catch (err) {
        deps.log(`best-of-n: run failed: ${(err as Error).message}`);
        vscode.window.showErrorMessage(`Best-of-N failed: ${(err as Error).message}`);
      }
    }),
  );
}
