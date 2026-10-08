// sunday-agent — style inference command (Group B2).
//
// `sunday.style.infer` re-runs project style inference on demand and stores
// the result in `~/.sunday/styles/<project-hash>.json` (see @sunday/context
// style-infer.ts). The daemon auto-infers once per project on the first
// session when no stored file exists (gated by `sunday.style.autoInfer`),
// so this command is the manual refresh path.
import * as vscode from 'vscode';
import {
  formatStyleForPrompt,
  inferStyle,
  loadStoredStyle,
  saveStyle,
} from '@sunday/context';

export interface StyleInferDeps {
  getWorkspaceRoot(): string | undefined;
  log(msg: string): void;
}

/**
 * Register the `sunday.style.infer` command. Shows the detected summary
 * (or a graceful message when nothing was detected) in an info message.
 */
export function registerStyleInfer(
  context: vscode.ExtensionContext,
  deps: StyleInferDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sunday.style.infer', async () => {
      const root = deps.getWorkspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage('Sunday: no workspace folder open.');
        return;
      }
      try {
        const previous = loadStoredStyle(root);
        const style = inferStyle(root);
        saveStyle(root, style);
        const summary = formatStyleForPrompt(style);
        deps.log(`style.infer: ${summary}${previous ? '' : ' (first inference for this project)'}`);
        vscode.window.showInformationMessage(`Sunday: code style updated — ${summary}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Sunday: style inference failed: ${(err as Error).message}`);
      }
    }),
  );
}
