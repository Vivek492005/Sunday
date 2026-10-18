/**
 * VS Code `keybindings.json` → canonical Sunday keybindings.
 *
 * Output lands in `~/.sunday-ide/keybindings.json`, staged for the future
 * Sunday keybinding engine. Well-known VS Code commands are remapped to
 * their Sunday equivalents; anything else is carried over verbatim and
 * flagged for manual review.
 */
import type { SundayKeybinding, UnconvertibleItem } from './types.js';

export interface KeybindingConversion {
  bindings: SundayKeybinding[];
  remapped: { from: string; to: string }[];
  carriedOver: string[];
}

/** VS Code command → Sunday command id. */
const COMMAND_MAP: Record<string, string> = {
  'workbench.action.quickOpen': 'sunday.quickOpen',
  'workbench.action.showCommands': 'sunday.commandPalette',
  'workbench.action.toggleSidebarVisibility': 'sunday.toggleSidebar',
  'workbench.action.terminal.toggleTerminal': 'sunday.togglePanel',
  'workbench.action.files.save': 'sunday.saveFile',
  'workbench.action.files.saveAll': 'sunday.saveAllFiles',
  'workbench.action.closeActiveEditor': 'sunday.closeTab',
  'workbench.action.navigateBack': 'sunday.navigateBack',
  'workbench.action.navigateForward': 'sunday.navigateForward',
  'workbench.action.findInFiles': 'sunday.viewSearch',
  'workbench.view.explorer': 'sunday.viewExplorer',
  'workbench.view.scm': 'sunday.viewSource',
  'workbench.view.debug': 'sunday.viewDebug',
  'workbench.view.extensions': 'sunday.viewExtensions',
  'workbench.action.openSettings': 'sunday.openSettings',
  'editor.action.formatDocument': 'sunday.formatDocument',
  'editor.action.commentLine': 'sunday.toggleLineComment',
};

interface VscodeKeybinding {
  key?: unknown;
  command?: unknown;
  when?: unknown;
  args?: unknown;
}

/** Convert parsed keybindings.json (array). Pure. */
export function convertVscodeKeybindings(raw: unknown): KeybindingConversion {
  const bindings: SundayKeybinding[] = [];
  const remapped: { from: string; to: string }[] = [];
  const carriedOver: string[] = [];

  if (!Array.isArray(raw)) {
    return { bindings, remapped, carriedOver };
  }
  for (const entry of raw as VscodeKeybinding[]) {
    if (typeof entry?.key !== 'string' || typeof entry?.command !== 'string') continue;
    // Negative bindings ("-command") remove a default — nothing to carry.
    if (entry.command.startsWith('-')) continue;
    const mapped = COMMAND_MAP[entry.command];
    const binding: SundayKeybinding = {
      key: entry.key,
      command: mapped ?? entry.command,
    };
    if (typeof entry.when === 'string' && entry.when.trim()) {
      // VS Code `when` clauses reference VS Code contexts; keep the text so
      // the future engine (or the user) can translate them.
      binding.when = entry.when;
    }
    if (mapped) {
      binding.remappedFrom = entry.command;
      remapped.push({ from: entry.command, to: mapped });
    } else {
      carriedOver.push(entry.command);
    }
    bindings.push(binding);
  }
  return { bindings, remapped, carriedOver };
}

export function keybindingAttentionItems(
  sourceLabel: string,
  conv: KeybindingConversion,
): UnconvertibleItem[] {
  const items: UnconvertibleItem[] = [];
  if (conv.carriedOver.length > 0) {
    const shown = [...new Set(conv.carriedOver)].slice(0, 8).join(', ');
    items.push({
      source: sourceLabel,
      item: `${conv.carriedOver.length} binding(s) kept with original VS Code command ids`,
      reason:
        `No Sunday equivalent yet for: ${shown}. They are staged in ` +
        `~/.sunday-ide/keybindings.json and will no-op until Sunday gains those commands — review and remap manually.`,
    });
  }
  return items;
}
