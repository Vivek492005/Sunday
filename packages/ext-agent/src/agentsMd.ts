// sunday-agent — AGENTS.md watcher + reload command (Group B1).
//
// The daemon injects AGENTS.md into every session's system prompt (fresh
// per session, so edits apply automatically). This module owns the
// extension side: a file watcher that tells the user when AGENTS.md
// changes, and `sunday.agentsMd.reload` which reports what is currently
// loaded. Loading reuses @sunday/context (loadAgentsMd/formatForPrompt).
import * as vscode from 'vscode';
import {
  AGENTS_MD_FILE,
  formatForPrompt,
  loadAgentsMd,
  type AgentsMdLoad,
} from '@sunday/context';

export interface AgentsMdDeps {
  getWorkspaceRoot(): string | undefined;
  log(msg: string): void;
}

/** Human-readable summary of the loaded AGENTS.md files (pure, testable). */
export function summarizeAgentsMd(loaded: AgentsMdLoad): string {
  const sources: string[] = [];
  if (loaded.rootSource) sources.push(loaded.rootSource);
  for (const dir of loaded.overrides.keys()) sources.push(`${dir}/${AGENTS_MD_FILE}`);
  if (sources.length === 0) return 'No AGENTS.md found (searched the workspace root and 3 parent levels).';
  const preview = formatForPrompt(loaded);
  return `Loaded AGENTS.md from:\n${sources.map((s) => `• ${s}`).join('\n')}\n\nApplies to new sessions automatically (${preview.length} prompt chars).`;
}

function notifyChange(deps: AgentsMdDeps, uri: vscode.Uri, kind: 'changed' | 'created' | 'deleted'): void {
  deps.log(`agentsMd: ${uri.fsPath} ${kind}`);
  if (kind === 'deleted') {
    vscode.window.showInformationMessage('AGENTS.md was removed — new sessions will no longer include its instructions.');
  } else {
    vscode.window.showInformationMessage('AGENTS.md changed — new agent sessions will pick it up automatically.');
  }
}

/**
 * Register the AGENTS.md file watcher plus the sunday.agentsMd.reload
 * command. Returns disposables via context.subscriptions.
 */
export function registerAgentsMd(
  context: vscode.ExtensionContext,
  deps: AgentsMdDeps,
): void {
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${AGENTS_MD_FILE}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidChange((uri) => notifyChange(deps, uri, 'changed')),
    watcher.onDidCreate((uri) => notifyChange(deps, uri, 'created')),
    watcher.onDidDelete((uri) => notifyChange(deps, uri, 'deleted')),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sunday.agentsMd.reload', () => {
      const root = deps.getWorkspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage('Sunday: no workspace folder open.');
        return;
      }
      try {
        const loaded = loadAgentsMd(root);
        deps.log(`agentsMd.reload: ${summarizeAgentsMd(loaded).split('\n')[0]}`);
        vscode.window.showInformationMessage(summarizeAgentsMd(loaded));
      } catch (err) {
        vscode.window.showErrorMessage(`Sunday: failed to load AGENTS.md: ${(err as Error).message}`);
      }
    }),
  );
}
