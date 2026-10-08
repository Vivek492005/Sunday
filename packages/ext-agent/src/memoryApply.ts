// sunday-agent — `sunday.memory.applyFrom` (Group B5: cross-project learning).
//
// Lets the user pull Second Brain memories from *another* project into the
// current session: quickpick a project → search → multi-select memories →
// the selection is sent to the agent inside an explicit
// `<imported-memories>` block (clearly delimited, never silent).
//
// The store is typed structurally (`CrossProjectStore`) so this module
// needs no hard dependency on @sunday/skills — the extension adapts the
// JSONL file directly (same pattern as memoryPanel.ts).
import * as vscode from 'vscode';

/** Structural shape of a long-term memory record. */
export interface CrossProjectMemory {
  id: string;
  text: string;
  timestamp: string;
  project: string;
  tags: string[];
  source: 'auto' | 'manual';
}

/** Structural shape of the cross-project query surface. */
export interface CrossProjectStore {
  listProjects(): Promise<string[]>;
  queryByProject(projectId: string, query: string, limit?: number): Promise<CrossProjectMemory[]>;
}

export interface MemoryApplyDeps {
  store: CrossProjectStore;
  /** Project id of the current workspace (excluded from the picker). */
  currentProjectId(): string | undefined;
  /** Send a message to the agent (AgentSender). */
  sendToAgent(message: string): Promise<void>;
  log(msg: string): void;
}

/** Max memories offered per search. */
export const APPLY_SEARCH_LIMIT = 10;
/** Max chars of memory text shown in the picker label. */
export const APPLY_LABEL_MAX = 80;

/** One-line picker label for a memory. */
export function memoryPickLabel(mem: CrossProjectMemory): string {
  const clean = mem.text.replace(/\s+/g, ' ');
  return clean.length > APPLY_LABEL_MAX ? `${clean.slice(0, APPLY_LABEL_MAX)}…` : clean;
}

/** Picker detail line: tags + date. */
export function memoryPickDetail(mem: CrossProjectMemory): string {
  const tags = mem.tags.length > 0 ? mem.tags.join(', ') : 'note';
  return `${tags} · ${mem.timestamp.slice(0, 10)}`;
}

/**
 * Format selected memories as a clearly delimited block for injection
 * into the agent session.
 */
export function formatImportedMemories(mems: CrossProjectMemory[], sourceProject: string): string {
  const lines = mems.map(
    (m) => `- [${m.timestamp.slice(0, 10)}][${m.tags.join(',') || 'note'}] ${m.text.replace(/\s+/g, ' ')}`,
  );
  return (
    `<imported-memories project="${sourceProject}" count="${mems.length}">\n` +
    `${lines.join('\n')}\n` +
    `</imported-memories>\n\n` +
    `The memories above were imported from another project (${sourceProject}) for reference. ` +
    `Use them as context where relevant and acknowledge briefly.`
  );
}

/** Register the `sunday.memory.applyFrom` command. */
export function registerMemoryApplyFrom(
  context: vscode.ExtensionContext,
  deps: MemoryApplyDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sunday.memory.applyFrom', async () => {
      const current = deps.currentProjectId();
      let projects: string[];
      try {
        projects = (await deps.store.listProjects()).filter((p) => p !== current);
      } catch (err) {
        vscode.window.showErrorMessage(`Sunday: could not list memory projects: ${(err as Error).message}`);
        return;
      }
      if (projects.length === 0) {
        vscode.window.showInformationMessage('Sunday: no memories from other projects yet.');
        return;
      }

      const projectPick = await vscode.window.showQuickPick(
        projects.map((p) => ({ label: p })),
        { placeHolder: 'Apply memories from which project?' },
      );
      if (!projectPick) return;
      const sourceProject = projectPick.label;

      const query = (await vscode.window.showInputBox({
        prompt: `Search memories in project "${sourceProject}" (empty = newest)`,
        placeHolder: 'e.g. deployment decision',
      })) ?? '';

      let results: CrossProjectMemory[];
      try {
        results = await deps.store.queryByProject(sourceProject, query, APPLY_SEARCH_LIMIT);
      } catch (err) {
        vscode.window.showErrorMessage(`Sunday: memory search failed: ${(err as Error).message}`);
        return;
      }
      if (results.length === 0) {
        vscode.window.showInformationMessage(`Sunday: no memories matched in project "${sourceProject}".`);
        return;
      }

      const picks = await vscode.window.showQuickPick(
        results.map((mem) => ({
          label: memoryPickLabel(mem),
          detail: memoryPickDetail(mem),
          mem,
        })),
        { canPickMany: true, placeHolder: `Select memories to apply from "${sourceProject}"` },
      );
      if (!picks || picks.length === 0) return;

      const message = formatImportedMemories(picks.map((p) => p.mem), sourceProject);
      try {
        await deps.sendToAgent(message);
        deps.log(`memory.applyFrom: injected ${picks.length} memories from ${sourceProject}`);
        vscode.window.showInformationMessage(
          `Sunday: applied ${picks.length} ${picks.length === 1 ? 'memory' : 'memories'} from project "${sourceProject}".`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Sunday: could not send memories to the agent: ${(err as Error).message}`);
      }
    }),
  );
}
