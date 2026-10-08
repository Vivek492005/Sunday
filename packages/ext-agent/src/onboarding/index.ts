// sunday-agent — `sunday.onboardRepo` (Workflow, C3): repo onboarding wizard.
//
// Analyzes the workspace (package.json, pyproject.toml, go.mod, Cargo.toml,
// Dockerfile, README.md, .env.example …), detects the stack / package manager /
// dev & build commands, and presents a checklist webview. Each step runs from
// a button and updates the checklist live; terminal steps are approval-gated
// through an explicit modal (P0: generated/derived commands never run
// silently). Ends with a summary of what worked vs what needs manual attention.

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ONBOARDING_FILES,
  analyzeRepo,
  type OnboardingFileName,
  type RepoAnalysis,
} from './detect.js';
import { applyStepUpdate, initialChecklist, summarize, type ChecklistStep } from './state.js';
import { buildOnboardingHtml } from './html.js';

const execFileAsync = promisify(execFile);
const RUN_TIMEOUT_MS = 5 * 60_000;

export interface ShellResult {
  exitCode: number;
  output: string;
}

export interface OnboardRepoDeps {
  log: (msg: string) => void;
  /** Injectable for tests; defaults to vscode.workspace.fs reads. */
  readWorkspaceFile?: (fsPath: string) => Promise<string | null>;
  /** Injectable for tests; defaults to vscode.workspace.fs writes. */
  writeWorkspaceFile?: (fsPath: string, content: string) => Promise<void>;
  /** Injectable for tests; defaults to a real subprocess run. */
  runShell?: (command: string, cwd: string) => Promise<ShellResult>;
  /** Injectable for tests; defaults to vscode.window.createTerminal. */
  launchInTerminal?: (name: string, command: string) => void;
}

async function defaultRunShell(command: string, cwd: string): Promise<ShellResult> {
  const isWin = process.platform === 'win32';
  try {
    const { stdout, stderr } = await execFileAsync(
      isWin ? 'powershell.exe' : 'sh',
      isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
      { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 8_000_000, windowsHide: true },
    );
    const out = `${stdout}${stderr}`.trim();
    return { exitCode: 0, output: out.slice(-4000) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message || 'failed';
    return { exitCode: typeof err.code === 'number' ? err.code : 1, output: out.slice(-4000) };
  }
}

export function registerOnboardRepo(
  context: vscode.ExtensionContext,
  deps: OnboardRepoDeps,
): void {
  const readWorkspaceFile =
    deps.readWorkspaceFile ??
    (async (fsPath: string): Promise<string | null> => {
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
        return Buffer.from(data).toString('utf8');
      } catch {
        return null;
      }
    });
  const writeWorkspaceFile =
    deps.writeWorkspaceFile ??
    (async (fsPath: string, content: string): Promise<void> => {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), Buffer.from(content, 'utf8'));
    });
  const runShell = deps.runShell ?? defaultRunShell;
  const launchInTerminal =
    deps.launchInTerminal ??
    ((name: string, command: string) => {
      const term = vscode.window.createTerminal(name);
      term.show();
      term.sendText(command);
    });

  context.subscriptions.push(
    vscode.commands.registerCommand('sunday.onboardRepo', async () => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsFolder) {
        vscode.window.showErrorMessage('Sunday: open a folder first to onboard a repository.');
        return;
      }

      // Analyze.
      const files: Record<string, string | null> = {};
      for (const name of ONBOARDING_FILES as readonly OnboardingFileName[]) {
        files[name] = await readWorkspaceFile(`${wsFolder}/${name}`);
      }
      const analysis: RepoAnalysis = analyzeRepo(files);
      let steps: ChecklistStep[] = initialChecklist(analysis);
      deps.log(`onboardRepo: stack=${analysis.stack} pm=${analysis.packageManager ?? 'n/a'} steps=${steps.length}`);

      const panel = vscode.window.createWebviewPanel(
        'sundayOnboardRepo',
        'Sunday: Onboard Repository',
        vscode.ViewColumn.One,
        { enableScripts: true },
      );
      const postState = (): void => {
        void panel.webview.postMessage({ type: 'state', steps });
      };
      const setStep = (id: string, patch: Parameters<typeof applyStepUpdate>[2]): void => {
        steps = applyStepUpdate(steps, id, patch);
        postState();
      };
      panel.webview.html = buildOnboardingHtml(analysis, steps);

      /** P0 approval gate: an explicit modal before any derived command runs. */
      const approved = async (command: string, what: string): Promise<boolean> => {
        const choice = await vscode.window.showWarningMessage(
          `Sunday onboarding: ${what}?\n\n${command}`,
          { modal: true },
          'Run',
          'Cancel',
        );
        return choice === 'Run';
      };

      panel.webview.onDidReceiveMessage(async (msg: { type?: string; stepId?: string }) => {
        if (msg.type === 'copyEnv') {
          const example = files['.env.example'];
          if (example == null) {
            setStep('env', { status: 'skipped', detail: '.env.example disappeared' });
            return;
          }
          const existing = await readWorkspaceFile(`${wsFolder}/.env`);
          if (existing != null) {
            const choice = await vscode.window.showWarningMessage(
              'Sunday onboarding: .env already exists. Overwrite it from .env.example?',
              { modal: true },
              'Overwrite',
              'Keep existing',
            );
            if (choice !== 'Overwrite') {
              setStep('env', { status: 'skipped', detail: '.env already exists — kept as-is' });
              return;
            }
          }
          await writeWorkspaceFile(`${wsFolder}/.env`, example);
          setStep('env', {
            status: 'done',
            detail: 'Created .env from .env.example — fill in the values before running.',
          });
          vscode.window.showInformationMessage('Sunday: .env created from .env.example.');
          return;
        }

        if (msg.type === 'run') {
          const step = steps.find((s) => s.id === msg.stepId);
          const command = step?.command;
          if (!step || !command) return;

          if (step.action === 'dev') {
            // Long-running: launch in a visible terminal, don't block on exit.
            if (!(await approved(command, 'start the dev server in a new terminal'))) return;
            launchInTerminal('Sunday: dev', command);
            setStep(step.id, { status: 'running', detail: `${command} — running in terminal "Sunday: dev"` });
            return;
          }

          const what = step.action === 'install' ? 'install dependencies' : 'run the build';
          if (!(await approved(command, what))) return;
          setStep(step.id, { status: 'running', detail: `${command} — running…` });
          deps.log(`onboardRepo: running ${command}`);
          const res = await runShell(command, wsFolder);
          if (res.exitCode === 0) {
            setStep(step.id, { status: 'done', detail: `${command} — succeeded` });
          } else {
            setStep(step.id, {
              status: 'failed',
              detail: `${command} — exit ${res.exitCode}. ${res.output.split('\n').slice(-5).join(' ')}`.slice(0, 500),
            });
          }
          return;
        }
      });

      panel.onDidDispose(() => {
        const { worked, needsAttention } = summarize(steps);
        deps.log(`onboardRepo: done. worked=${worked.length} attention=${needsAttention.length}`);
        if (needsAttention.length === 0) {
          vscode.window.showInformationMessage(
            `Sunday: onboarding complete — ${worked.length} step(s) done.`,
          );
        } else {
          vscode.window.showWarningMessage(
            `Sunday: onboarding finished with ${needsAttention.length} item(s) needing attention:\n${needsAttention.join('\n')}`,
          );
        }
      });
    }),
  );
}
