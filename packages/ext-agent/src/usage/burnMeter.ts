// sunday-agent — F1 Cost & Quota Cockpit: live burn meter (status bar).
//
// Shows remaining daily requests, reset time, and current-task spend at a
// glance:  `$(dashboard) 142/200 · resets 00:00 UTC`
// Click → opens the Sunday Usage dashboard. All data sources are injectable
// so the rendering logic is unit-tested without vscode.

import * as vscode from 'vscode';
import { USAGE_SHOW_COMMAND } from './usagePanel.js';

/** Injectable data sources for the burn meter (vscode-free in tests). */
export interface BurnMeterDeps {
  /** Plan daily request limit (from entitlements). Undefined = unknown. */
  getDailyLimit?: () => number | undefined;
  /** Requests used today (local counter). */
  getUsedToday?: () => number;
  /** Human reset label, e.g. "00:00 UTC". */
  getResetLabel?: () => string;
  /** Requests spent on the current task. Undefined = no active task. */
  getTaskSpend?: () => number | undefined;
  /** Refresh interval ms (default 30s). */
  refreshMs?: number;
  log?: (msg: string) => void;
}

/** Pure: status-bar text for the meter. */
export function burnMeterText(
  usedToday: number,
  dailyLimit: number | undefined,
  taskSpend: number | undefined,
): string {
  const used = Math.max(0, Math.floor(usedToday));
  const limitPart = dailyLimit !== undefined ? `/${dailyLimit}` : '';
  const taskPart = taskSpend !== undefined && taskSpend > 0 ? ` · task ${taskSpend}` : '';
  return `$(dashboard) ${used}${limitPart}${taskPart}`;
}

/** Pure: tooltip text for the meter. */
export function burnMeterTooltip(
  usedToday: number,
  dailyLimit: number | undefined,
  resetLabel: string,
  taskSpend: number | undefined,
): string {
  const lines = ['Sunday quota — live burn meter'];
  if (dailyLimit !== undefined) {
    const remaining = Math.max(0, dailyLimit - Math.max(0, Math.floor(usedToday)));
    lines.push(`${remaining} of ${dailyLimit} daily requests remaining`);
  } else {
    lines.push(`${Math.max(0, Math.floor(usedToday))} requests used today`);
  }
  lines.push(`Resets ${resetLabel}`);
  if (taskSpend !== undefined && taskSpend > 0) lines.push(`Current task: ${taskSpend} requests`);
  lines.push('', 'Click for the full usage dashboard.');
  return lines.join('\n');
}

/**
 * Register the burn-meter status bar item. Refreshes on an interval and
 * exposes `sunday.usage.burnRefresh` for manual refreshes.
 */
export function registerBurnMeter(
  context: vscode.ExtensionContext,
  deps: BurnMeterDeps = {},
): vscode.Disposable {
  const log = deps.log ?? (() => undefined);
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  item.name = 'Sunday Burn Meter';
  item.command = USAGE_SHOW_COMMAND;

  const render = (): void => {
    try {
      const used = deps.getUsedToday?.() ?? 0;
      const limit = deps.getDailyLimit?.();
      const task = deps.getTaskSpend?.();
      const reset = deps.getResetLabel?.() ?? '00:00 UTC';
      item.text = burnMeterText(used, limit, task);
      item.tooltip = burnMeterTooltip(used, limit, reset, task);
      item.show();
    } catch (err) {
      log(`burnMeter: render failed: ${(err as Error).message}`);
    }
  };

  render();
  const timer = setInterval(render, deps.refreshMs ?? 30_000);
  const cmd = vscode.commands.registerCommand('sunday.usage.burnRefresh', render);

  return {
    dispose: () => {
      clearInterval(timer);
      cmd.dispose();
      item.dispose();
    },
  };
}
