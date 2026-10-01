// sunday-agent — `sunday.terminal.explainError` (Part B, Worker 3).
//
// DESIGN DECISION (documented for the brief): we implement the
// shell-integration tracker — an activate-time
// `vscode.window.onDidEndTerminalShellExecution` listener that keeps an
// in-memory ring of the last 10 failed executions (command line, exit code,
// last ~20k chars of output). This IS the simple path: one listener, no
// persisted state, no per-terminal bookkeeping.
//
// Fallback: when no failure has been tracked (shell integration unavailable
// or nothing failed yet), the command asks the user to paste the error text
// via an input box. Note there is deliberately no "read the terminal's
// selection" step: VS Code exposes the selection *range* but not its text
// without shell integration, so pasting is the honest fallback.
//
// Sending policy matches the other Part B features (see agentSend.ts):
// direct `chatSend`, then focus the chat view so the turn streams visibly.
//
// Pure, unit-tested helpers: buildTerminalErrorPrompt,
// truncateTerminalOutput, readExecutionOutput.
import * as vscode from 'vscode';
import { AgentSender, type AgentSendDeps } from './agentSend.js';

/** Cap on terminal output embedded in a prompt (keeps the tail — errors land at the end). */
export const TERMINAL_OUTPUT_MAX_CHARS = 6000;

/** How much raw output we retain per tracked failure. */
export const TRACKED_OUTPUT_MAX_CHARS = 20_000;

/** Max failures remembered. */
export const TRACKED_FAILURES_MAX = 10;

export interface TerminalFailure {
  command: string;
  exitCode: number;
  output: string;
  at: number;
}

/** Truncate terminal output, keeping the tail where the error usually is. */
export function truncateTerminalOutput(
  output: string,
  maxChars = TERMINAL_OUTPUT_MAX_CHARS,
): { output: string; truncated: boolean } {
  if (output.length <= maxChars) return { output, truncated: false };
  return {
    output: `…[truncated ${output.length - maxChars} chars]\n` + output.slice(output.length - maxChars),
    truncated: true,
  };
}

/** Prompt: explain this terminal failure and suggest a fix. */
export function buildTerminalErrorPrompt(f: {
  command: string;
  exitCode?: number;
  output: string;
}): string {
  const { output, truncated } = truncateTerminalOutput(f.output);
  return [
    'My terminal command failed. Explain the error and suggest a concrete fix.',
    `Command: ${f.command}`,
    f.exitCode !== undefined ? `Exit code: ${f.exitCode}` : '',
    truncated ? '(Note: output was truncated to the last lines.)' : '',
    '',
    '```',
    output,
    '```',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Drain a TerminalShellExecution's async output stream into a string. */
export async function readExecutionOutput(exec: {
  read(): AsyncIterable<string>;
}): Promise<string> {
  let out = '';
  for await (const chunk of exec.read()) out += chunk;
  return out;
}

/** In-memory ring buffer for the last failures (testable without vscode). */
export class FailureTracker {
  private readonly failures: TerminalFailure[] = [];

  record(f: Omit<TerminalFailure, 'at'>): void {
    this.failures.unshift({ ...f, at: Date.now() });
    if (this.failures.length > TRACKED_FAILURES_MAX) this.failures.length = TRACKED_FAILURES_MAX;
  }

  latest(): TerminalFailure | undefined {
    return this.failures[0];
  }

  get size(): number {
    return this.failures.length;
  }
}

/** Register the shell-integration listener + the explain command. */
export function registerTerminalExplain(
  context: vscode.ExtensionContext,
  deps: AgentSendDeps,
): void {
  const sender = new AgentSender(deps);
  const tracker = new FailureTracker();

  const onEnd = vscode.window.onDidEndTerminalShellExecution;
  if (typeof onEnd === 'function') {
    const listener = onEnd(async (e) => {
      try {
        const exitCode = e.exitCode;
        if (exitCode === undefined || exitCode === 0) return;
        const command = e.execution.commandLine.value;
        const raw = await readExecutionOutput(e.execution);
        tracker.record({
          command,
          exitCode,
          output: raw.slice(-TRACKED_OUTPUT_MAX_CHARS),
        });
        deps.log(`terminalExplain: tracked failure (exit ${exitCode}): ${command}`);
      } catch (err) {
        deps.log(`terminalExplain: tracker failed: ${(err as Error).message}`);
      }
    });
    context.subscriptions.push(listener);
  } else {
    deps.log('terminalExplain: shell-integration events unavailable (old VS Code?) — paste fallback only');
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('sunday.terminal.explainError', async () => {
      const failure = tracker.latest();
      let command = '(pasted error output)';
      let exitCode: number | undefined;
      let output: string | undefined;

      if (failure) {
        ({ command, exitCode, output } = failure);
      } else {
        const pasted = await vscode.window.showInputBox({
          title: 'Sunday: Explain Terminal Error',
          prompt: 'No recent terminal failure was tracked — paste the error output to explain',
          placeHolder: 'Paste the failing command output here…',
        });
        if (!pasted?.trim()) return;
        output = pasted;
      }

      try {
        await sender.send(buildTerminalErrorPrompt({ command, exitCode, output }));
      } catch (err) {
        deps.log(`terminalExplain failed: ${(err as Error).message}`);
        vscode.window.showErrorMessage(`Sunday explain failed: ${(err as Error).message}`);
      }
    }),
  );
}
