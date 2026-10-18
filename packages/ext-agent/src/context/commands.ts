// sunday-agent — F4 Context Cockpit: vscode glue for context commands.
//
// Registers palette commands that mirror the chat slash commands
// (/compact, /pin, /forget). Chat interception lives in slashCommands.ts
// (pure) and is wired into chatView.handleSend.

import * as vscode from 'vscode';
import type { ContextMeter } from './meter.js';
import type { PinnedStore } from './pinned.js';

/** Command id: show the live context meter. */
export const CONTEXT_METER_COMMAND = 'sunday.context.meter';
/** Command id: run compaction preview. */
export const CONTEXT_COMPACT_COMMAND = 'sunday.context.compact';
/** Command id: pin a fact via input box. */
export const CONTEXT_PIN_COMMAND = 'sunday.context.pin';

export interface ContextCommandDeps {
  meter: ContextMeter;
  pinned: PinnedStore;
  log?: (msg: string) => void;
  /** Focus the chat view so the user can type the slash command. */
  focusChat?: () => void;
}

/**
 * Register `sunday.context.meter`, `sunday.context.compact`, `sunday.context.pin`.
 */
export function registerContextCommands(
  context: vscode.ExtensionContext,
  deps: ContextCommandDeps,
): vscode.Disposable[] {
  const log = deps.log ?? (() => undefined);
  const out: vscode.Disposable[] = [];

  out.push(
    vscode.commands.registerCommand(CONTEXT_METER_COMMAND, async () => {
      const u = deps.meter.getContextUsage();
      const rows = Object.entries(u.breakdown)
        .map(([k, v]) => `  ${k}: ${v.toLocaleString('en-IN')} tokens`)
        .join('\n');
      const pct = Math.round(u.percent * 100);
      void vscode.window.showInformationMessage(
        `Sunday context: ${u.used.toLocaleString('en-IN')}/${u.limit.toLocaleString('en-IN')} tokens (${pct}%)\n${rows}`,
        { modal: false },
      );
      log(`context meter shown: ${u.used}/${u.limit}`);
    }),
  );

  out.push(
    vscode.commands.registerCommand(CONTEXT_COMPACT_COMMAND, async () => {
      deps.focusChat?.();
      void vscode.window.showInformationMessage(
        'Chat me `/compact` likho — preview dekho, fir `/compact go` se chalao.',
      );
    }),
  );

  out.push(
    vscode.commands.registerCommand(CONTEXT_PIN_COMMAND, async () => {
      const text = await vscode.window.showInputBox({
        prompt: 'Pin a fact (never compacted): e.g. "never touch src/auth"',
        placeHolder: 'never touch …',
      });
      if (!text?.trim()) return;
      const fact = deps.pinned.pinFact(text.trim(), 'user');
      void vscode.window.showInformationMessage(`📌 Pinned: ${fact.text}`);
      log(`context pin: ${fact.id}`);
    }),
  );

  return out;
}
