// sunday-agent — F4 Context Cockpit: /compact, /pin, /forget chat commands.
//
// Intercepts slash commands typed into the chat input BEFORE the text reaches
// the agent bridge. Pure (no vscode import) — the vscode glue lives in
// commands.ts. Unit-tested.

import {
  compact,
  editLedgerSummary,
  previewCompaction,
  undoCompaction,
} from './compaction.js';
import { formatTokens } from './tokenizer.js';
import type {
  CompactionLedger,
  CompactionOptions,
  SlashCommand,
  TrackedMessage,
} from './types.js';
import type { ContextMeter } from './meter.js';
import type { PinnedStore } from './pinned.js';

export const SLASH_COMMANDS = ['/compact', '/pin', '/forget'] as const;

/**
 * Parse a chat input into a slash command. Returns null when the input is
 * not one of the context commands.
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const t = text.trim();
  for (const name of ['/compact', '/pin', '/forget'] as const) {
    if (t === name || t.startsWith(`${name} `)) {
      return { command: name.slice(1) as SlashCommand['command'], args: t.slice(name.length).trim() };
    }
  }
  return null;
}

export interface SlashDeps {
  meter: ContextMeter;
  pinned: PinnedStore;
  /** Live message list (mutated in place by compaction). */
  messages: TrackedMessage[];
  /** Replace the message list (e.g. after undo). */
  setMessages: (msgs: TrackedMessage[]) => void;
  /** Ledgers for undo history. */
  ledgers: CompactionLedger[];
  compactionOpts?: CompactionOptions;
  /** Archived tool-output texts for byte-identical undo (messageId → text). */
  archivedTexts?: Record<string, string>;
  /** Render a reply into the chat UI. */
  reply: (markdown: string) => void;
}

function fmtList(ids: string[]): string {
  return ids.length === 0 ? '—' : ids.join(', ');
}

/**
 * Handle a parsed slash command. Returns true when handled.
 */
export function handleSlashCommand(cmd: SlashCommand, deps: SlashDeps): boolean {
  switch (cmd.command) {
    case 'compact':
      return handleCompact(cmd, deps);
    case 'pin':
      return handlePin(cmd, deps);
    case 'forget':
      return handleForget(cmd, deps);
    default:
      return false;
  }
}

function handleCompact(cmd: SlashCommand, deps: SlashDeps): boolean {
  const arg = cmd.args.toLowerCase();
  if (arg === 'undo') {
    const last = deps.ledgers[deps.ledgers.length - 1];
    if (!last) {
      deps.reply('Koi compaction abhi tak hui nahi — undo karne ke liye kuch nahi hai.');
      return true;
    }
    const restored = undoCompaction(deps.messages, last, deps.archivedTexts);
    deps.setMessages(restored);
    deps.ledgers.pop();
    deps.reply(
      `↩️ Compaction **undone**. ${restored.length} messages restored ` +
        `(ledger \`${last.id}\`).`,
    );
    return true;
  }
  if (arg.startsWith('preview') || arg === '') {
    const preview = previewCompaction(deps.messages, deps.compactionOpts);
    deps.reply(
      `🔍 **Compaction preview**\n\n` +
        `- Summarize: ${preview.toSummarize.length} (${fmtList(preview.toSummarize.slice(0, 5))}${preview.toSummarize.length > 5 ? '…' : ''})\n` +
        `- Trim tool outputs: ${preview.toTrim.length}\n` +
        `- Protected (pinned): ${preview.protected.length}\n` +
        `- Tokens: ${formatTokens(preview.tokensBefore)} → ~${formatTokens(preview.tokensAfter)}\n\n` +
        `Draft summary:\n> ${preview.draftSummary.split('\n').join('\n> ') || '(nothing to summarize)'}\n\n` +
        `Type \`/compact go\` to run, \`/compact undo\` to revert the last one.`,
    );
    return true;
  }
  if (arg === 'go') {
    const { messages, ledger } = compact(deps.messages, deps.compactionOpts);
    deps.setMessages(messages);
    deps.ledgers.push(ledger);
    deps.reply(
      `🗜️ **Compacted.**\n\n` +
        `- Summarized ${ledger.removed.length} message(s) → 1 summary block\n` +
        `- Archived ${ledger.archivedOutputs.length} tool output(s)\n` +
        `- Tokens: ${formatTokens(ledger.tokensBefore)} → ${formatTokens(ledger.tokensAfter)}\n` +
        `- Ledger \`${ledger.id}\` — \`/compact undo\` se wapas lao.`,
    );
    return true;
  }
  // /compact edit <new summary> — edit the last ledger's summary.
  if (arg.startsWith('edit ')) {
    const last = deps.ledgers[deps.ledgers.length - 1];
    if (!last) {
      deps.reply('Edit karne ke liye koi ledger nahi hai.');
      return true;
    }
    const updated = editLedgerSummary(last, cmd.args.slice(5).trim());
    deps.ledgers[deps.ledgers.length - 1] = updated;
    deps.reply(`✏️ Ledger summary updated.`);
    return true;
  }
  deps.reply('Usage: `/compact` (preview) · `/compact go` · `/compact undo` · `/compact edit <text>`');
  return true;
}

function handlePin(cmd: SlashCommand, deps: SlashDeps): boolean {
  const arg = cmd.args.trim();
  if (!arg) {
    const pins = deps.pinned.listPinned();
    if (pins.length === 0) {
      deps.reply('📌 Koi pinned fact nahi hai. `/pin <text>` se pin karo.');
    } else {
      deps.reply(
        `📌 **Pinned facts** (${pins.length}):\n` +
          pins.map((p) => `- \`${p.id}\` — ${p.text}`).join('\n') +
          `\n\nUnpin: \`/forget ${pins[0].id}\``,
      );
    }
    return true;
  }
  const fact = deps.pinned.pinFact(arg, 'user');
  // Also mark matching live messages as pinned so compaction skips them.
  for (const m of deps.messages) {
    if (m.text.includes(arg.slice(0, 40))) m.pinned = true;
  }
  deps.meter.setSegment('pinned', deps.pinned.renderPinnedBlock(), 'pinned-block', 'Pinned facts');
  deps.reply(`📌 Pinned: "${fact.text}" (id \`${fact.id}\`) — yeh kabhi compact nahi hoga.`);
  return true;
}

function handleForget(cmd: SlashCommand, deps: SlashDeps): boolean {
  const arg = cmd.args.trim();
  if (!arg) {
    deps.reply('Usage: `/forget <pin-id>` — pehle `/pin` se ids dekho.');
    return true;
  }
  const ok = deps.pinned.unpinFact(arg);
  if (ok) {
    const block = deps.pinned.renderPinnedBlock();
    if (block) {
      deps.meter.setSegment('pinned', block, 'pinned-block', 'Pinned facts');
    } else {
      deps.meter.removeSegment('pinned-block');
    }
    deps.reply(`🗑️ Unpinned \`${arg}\`.`);
  } else {
    deps.reply(`\`${arg}\` naam ka koi pin nahi mila. \`/pin\` se list dekho.`);
  }
  return true;
}
