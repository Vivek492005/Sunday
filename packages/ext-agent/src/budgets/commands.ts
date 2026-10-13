// sunday-agent — F1 Cost & Quota Cockpit: vscode glue for budgets.
//
// Registers the one-click "continue +N" command and the budget settings
// command. The pause/warn semantics live in budgetStore.ts (pure).

import * as vscode from 'vscode';
import { BudgetTracker, saveBudgetConfig, type BudgetScope } from './budgetStore.js';

/** Command id: one-click "continue +N" after a hard-budget pause. */
export const BUDGET_CONTINUE_COMMAND = 'sunday.budget.continue';
/** Command id: open budget settings (quick pick). */
export const BUDGET_SETTINGS_COMMAND = 'sunday.budget.settings';

export interface BudgetCommandDeps {
  /** Shared tracker (created once at activation). */
  tracker: BudgetTracker;
  /** Persist config (globalState). */
  saveConfig?: (cfg: Parameters<typeof saveBudgetConfig>[1]) => Promise<void>;
  log?: (msg: string) => void;
}

const SCOPE_LABEL: Record<BudgetScope, string> = {
  task: 'Per task',
  session: 'Per session',
  day: 'Per day',
};

/**
 * Register `sunday.budget.continue` (one-click resume after hard pause)
 * and `sunday.budget.settings` (set soft/hard limits per scope).
 */
export function registerBudgetCommands(
  context: vscode.ExtensionContext,
  deps: BudgetCommandDeps,
): vscode.Disposable[] {
  const log = deps.log ?? (() => undefined);
  const out: vscode.Disposable[] = [];

  out.push(
    vscode.commands.registerCommand(BUDGET_CONTINUE_COMMAND, async () => {
      const paused = deps.tracker.pausedScopes();
      if (paused.length === 0) {
        void vscode.window.showInformationMessage('No paused budgets — Sunday is not blocked.');
        return;
      }
      const scopePick =
        paused.length === 1
          ? paused[0]
          : await vscode.window.showQuickPick(
              paused.map((s) => ({ label: SCOPE_LABEL[s], scope: s })),
              { placeHolder: 'Which budget do you want to extend?' },
            );
      const scope: BudgetScope | undefined =
        typeof scopePick === 'string' ? scopePick : scopePick?.scope;
      if (!scope) return;
      const raw = await vscode.window.showInputBox({
        prompt: `Continue the ${SCOPE_LABEL[scope].toLowerCase()} budget by how many requests?`,
        value: '10',
        validateInput: (v) => {
          const n = Number(v);
          return Number.isInteger(n) && n > 0 ? undefined : 'Enter a positive whole number.';
        },
      });
      if (!raw) return;
      const n = Math.floor(Number(raw));
      deps.tracker.continueAllowance(scope, n);
      log(`budget: continued ${scope} by +${n}`);
      void vscode.window.showInformationMessage(
        `Sunday budget extended: +${n} requests (${SCOPE_LABEL[scope].toLowerCase()}). Agent resumed.`,
      );
    }),
  );

  out.push(
    vscode.commands.registerCommand(BUDGET_SETTINGS_COMMAND, async () => {
      const scopePick = await vscode.window.showQuickPick(
        (['task', 'session', 'day'] as BudgetScope[]).map((s) => ({ label: SCOPE_LABEL[s], scope: s })),
        { placeHolder: 'Set budget for…' },
      );
      if (!scopePick) return;
      const scope = scopePick.scope;
      // Returns { cancelled: true } on dismiss, otherwise the chosen limit
      // (undefined = unlimited).
      const ask = async (
        label: string,
        current?: number,
      ): Promise<{ cancelled: boolean; value?: number }> => {
        const raw = await vscode.window.showInputBox({
          prompt: `${label} (${SCOPE_LABEL[scope].toLowerCase()}) — requests, empty = unlimited`,
          value: current !== undefined ? String(current) : '',
          validateInput: (v) => {
            if (v.trim() === '') return undefined;
            const n = Number(v);
            return Number.isInteger(n) && n > 0 ? undefined : 'Enter a positive whole number.';
          },
        });
        if (raw === undefined) return { cancelled: true };
        return { cancelled: false, value: raw.trim() === '' ? undefined : Math.floor(Number(raw)) };
      };
      const softAns = await ask('Soft budget (warn at)', deps.tracker.softLimit(scope));
      if (softAns.cancelled) return;
      const hardAns = await ask('Hard budget (pause at)', deps.tracker.hardLimit(scope));
      if (hardAns.cancelled) return;
      // Rebuild limits from current + answers.
      const next: Record<BudgetScope, { soft?: number; hard?: number }> = {
        task: {
          soft: scope === 'task' ? softAns.value : deps.tracker.softLimit('task'),
          hard: scope === 'task' ? hardAns.value : deps.tracker.hardLimit('task'),
        },
        session: {
          soft: scope === 'session' ? softAns.value : deps.tracker.softLimit('session'),
          hard: scope === 'session' ? hardAns.value : deps.tracker.hardLimit('session'),
        },
        day: {
          soft: scope === 'day' ? softAns.value : deps.tracker.softLimit('day'),
          hard: scope === 'day' ? hardAns.value : deps.tracker.hardLimit('day'),
        },
      };
      // Note: tracker.setLimits clears pause flags — intended after reconfig.
      deps.tracker.setLimits(next);
      try {
        if (deps.saveConfig) await deps.saveConfig(next);
        else await saveBudgetConfig(context.globalState as never, next);
      } catch {
        /* best-effort */
      }
      log(`budget: limits updated for ${scope}`);
      void vscode.window.showInformationMessage('Sunday budgets updated.');
    }),
  );

  return out;
}
