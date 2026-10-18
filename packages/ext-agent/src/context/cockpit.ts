// sunday-agent — F4 Context Cockpit: session-scoped cockpit holder.
//
// Bundles the meter, pinned store, tracked messages, and compaction ledgers
// for one chat session. The chat view creates one per session and routes
// /compact, /pin, /forget through it. Pure (no vscode import).

import { compact as runCompaction } from './compaction.js';
import { ContextMeter } from './meter.js';
import { PinnedStore } from './pinned.js';
import { handleSlashCommand } from './slashCommands.js';
import type { SlashCommand } from './types.js';
import type {
  CompactionLedger,
  CompactionOptions,
  TrackedMessage,
} from './types.js';

let msgCounter = 0;
function nextMsgId(prefix: string): string {
  msgCounter += 1;
  return `${prefix}-local-${Date.now()}-${msgCounter}`;
}

/**
 * ContextCockpit: one per chat session. Tracks user/assistant messages
 * locally, exposes the meter, pins, and compaction with ledger history.
 */
export class ContextCockpit {
  readonly meter: ContextMeter;
  readonly pinned: PinnedStore;
  private messages: TrackedMessage[] = [];
  private ledgers: CompactionLedger[] = [];
  private archivedTexts: Record<string, string> = {};
  private compactionOpts: CompactionOptions;

  constructor(opts: { modelId?: string; limit?: number; compactionOpts?: CompactionOptions } = {}) {
    this.meter = new ContextMeter({ modelId: opts.modelId, limit: opts.limit });
    this.pinned = new PinnedStore();
    this.compactionOpts = opts.compactionOpts ?? {};
  }

  /** Record a user message (call on every chat send). */
  trackUserMessage(text: string): TrackedMessage {
    const m: TrackedMessage = {
      id: nextMsgId('u'),
      role: 'user',
      text,
      createdAt: Date.now(),
    };
    this.messages.push(m);
    this.refreshHistorySegment();
    return m;
  }

  /** Record an assistant reply (slash-command replies, local notes). */
  trackAssistantMessage(text: string, toolOutput = false): TrackedMessage {
    const m: TrackedMessage = {
      id: nextMsgId('a'),
      role: 'assistant',
      text,
      toolOutput,
      createdAt: Date.now(),
    };
    this.messages.push(m);
    this.refreshHistorySegment();
    return m;
  }

  getMessages(): TrackedMessage[] {
    return [...this.messages];
  }

  setMessages(msgs: TrackedMessage[]): void {
    this.messages = [...msgs];
    this.refreshHistorySegment();
  }

  getLedgers(): CompactionLedger[] {
    return [...this.ledgers];
  }

  pushLedger(l: CompactionLedger): void {
    this.ledgers.push(l);
  }

  popLedger(): CompactionLedger | undefined {
    return this.ledgers.pop();
  }

  replaceLedger(id: string, l: CompactionLedger): void {
    const i = this.ledgers.findIndex((x) => x.id === id);
    if (i >= 0) this.ledgers[i] = l;
  }

  getArchivedTexts(): Record<string, string> {
    return { ...this.archivedTexts };
  }

  setArchivedText(messageId: string, text: string): void {
    this.archivedTexts[messageId] = text;
  }

  getCompactionOpts(): CompactionOptions {
    return { ...this.compactionOpts };
  }

  /** Keep the meter's history segment in sync with tracked messages. */
  private refreshHistorySegment(): void {
    const text = this.messages.map((m) => `[${m.role}] ${m.text}`).join('\n');
    this.meter.setSegment('history', text || ' ', 'history-local', 'Chat history');
  }

  /** Convenience: run compaction with artifact capture wired. */
  runLocalCompaction(): { messages: TrackedMessage[]; ledger: CompactionLedger } {
    const opts: CompactionOptions = {
      ...this.compactionOpts,
      writeArtifact: (dir, messageId, text) => {
        this.archivedTexts[messageId] = text;
        return `${dir}/${messageId}.log`;
      },
    };
    const { messages, ledger } = runCompaction(this.messages, opts);
    this.messages = messages;
    this.ledgers.push(ledger);
    this.refreshHistorySegment();
    // Meter the pinned block too.
    const block = this.pinned.renderPinnedBlock();
    if (block) this.meter.setSegment('pinned', block, 'pinned-block', 'Pinned facts');
    return { messages, ledger };
  }

  /** Current usage, with pinned facts counted. */
  usage(): ReturnType<ContextMeter['getContextUsage']> {
    const block = this.pinned.renderPinnedBlock();
    if (block) {
      this.meter.setSegment('pinned', block, 'pinned-block', 'Pinned facts');
    }
    return this.meter.getContextUsage();
  }

  /**
   * Route a parsed slash command through this cockpit with live internals
   * (real ledger array, real message list). Replies go to `reply`.
   */
  handleSlash(cmd: SlashCommand, reply: (markdown: string) => void): boolean {
    return handleSlashCommand(cmd, {
      meter: this.meter,
      pinned: this.pinned,
      messages: this.messages,
      setMessages: (m) => {
        this.messages = [...m];
        this.refreshHistorySegment();
      },
      ledgers: this.ledgers,
      compactionOpts: {
        ...this.getCompactionOpts(),
        // Capture full tool-output texts so undo can restore byte-identical.
        writeArtifact: (_dir, messageId, text) => {
          this.archivedTexts[messageId] = text;
          return `cockpit-archive://${messageId}`;
        },
      },
      archivedTexts: this.archivedTexts,
      reply,
    });
  }
}
