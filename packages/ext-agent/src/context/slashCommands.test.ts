// Tests for context/slashCommands.ts — /compact, /pin, /forget.
import { describe, expect, it } from 'vitest';
import { ContextMeter } from './meter.js';
import { PinnedStore } from './pinned.js';
import { handleSlashCommand, parseSlashCommand } from './slashCommands.js';
import type { CompactionLedger, TrackedMessage } from './types.js';
import type { SlashDeps } from './slashCommands.js';

// Build a SlashDeps with inspectable replies/messages.
function buildDeps(
  over: Partial<Pick<SlashDeps, 'meter' | 'pinned' | 'ledgers' | 'compactionOpts'>> & {
    messages?: TrackedMessage[];
  } = {},
): SlashDeps & { replies: string[]; getMessages: () => TrackedMessage[] } {
  const replies: string[] = [];
  const state = {
    messages: over.messages ?? [
      { id: 'u-1', role: 'user', text: 'hello', createdAt: 1 },
      { id: 'a-1', role: 'assistant', text: 'hi there', createdAt: 2 },
    ],
  };
  const deps: SlashDeps & { replies: string[]; getMessages: () => TrackedMessage[] } = {
    meter: over.meter ?? new ContextMeter({ limit: 10000 }),
    pinned: over.pinned ?? new PinnedStore(),
    messages: state.messages,
    setMessages: (m: TrackedMessage[]) => {
      state.messages = m;
      deps.messages = m;
    },
    ledgers: over.ledgers ?? [],
    compactionOpts: over.compactionOpts,
    reply: (md: string) => {
      replies.push(md);
    },
    replies,
    getMessages: () => state.messages,
  };
  return deps;
}

describe('parseSlashCommand', () => {
  it('parses the three commands with args', () => {
    expect(parseSlashCommand('/compact go')).toEqual({ command: 'compact', args: 'go' });
    expect(parseSlashCommand('/pin never touch X')).toEqual({ command: 'pin', args: 'never touch X' });
    expect(parseSlashCommand('/forget pin-1')).toEqual({ command: 'forget', args: 'pin-1' });
  });

  it('matches bare commands without args', () => {
    expect(parseSlashCommand('/compact')).toEqual({ command: 'compact', args: '' });
    expect(parseSlashCommand('  /pin  ')).toEqual({ command: 'pin', args: '' });
  });

  it('returns null for non-commands', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('/model gpt')).toBeNull();
    expect(parseSlashCommand('/compactx')).toBeNull();
  });
});

describe('/pin and /forget', () => {
  it('pins a fact and lists it', () => {
    const d = buildDeps();
    expect(handleSlashCommand({ command: 'pin', args: 'never touch src/auth' }, d)).toBe(true);
    expect(d.pinned.listPinned()).toHaveLength(1);
    expect(d.replies[0]).toContain('Pinned');

    handleSlashCommand({ command: 'pin', args: '' }, d);
    expect(d.replies[1]).toContain('never touch src/auth');
  });

  it('forgets a pin by id', () => {
    const d = buildDeps();
    handleSlashCommand({ command: 'pin', args: 'abc' }, d);
    const id = d.pinned.listPinned()[0].id;
    handleSlashCommand({ command: 'forget', args: id }, d);
    expect(d.pinned.listPinned()).toHaveLength(0);
    expect(d.replies[1]).toContain('Unpinned');
  });

  it('reports unknown pin ids', () => {
    const d = buildDeps();
    handleSlashCommand({ command: 'forget', args: 'nope' }, d);
    expect(d.replies[0]).toContain('nahi mila');
  });
});

describe('/compact', () => {
  function bigHistory(): TrackedMessage[] {
    const out: TrackedMessage[] = [
      { id: 'sys', role: 'system', text: 'sys prompt', createdAt: 0, pinned: true },
    ];
    for (let i = 0; i < 20; i += 1) {
      out.push({ id: `u-${i}`, role: 'user', text: `question number ${i} here`, createdAt: i + 1 });
      out.push({ id: `a-${i}`, role: 'assistant', text: `answer number ${i} here`, createdAt: i + 2 });
    }
    return out;
  }

  it('preview does not mutate messages', () => {
    const d = buildDeps({ messages: bigHistory() });
    const before = d.getMessages().length;
    handleSlashCommand({ command: 'compact', args: '' }, d);
    expect(d.getMessages().length).toBe(before);
    expect(d.ledgers).toHaveLength(0);
    expect(d.replies[0]).toContain('preview');
  });

  it('go compacts and pushes a ledger', () => {
    const d = buildDeps({ messages: bigHistory(), compactionOpts: { keepRecent: 4 } });
    handleSlashCommand({ command: 'compact', args: 'go' }, d);
    expect(d.ledgers).toHaveLength(1);
    expect(d.replies[0]).toContain('Compacted');
    // Pinned system message survived.
    expect(d.getMessages().some((m) => m.id === 'sys')).toBe(true);
  });

  it('undo restores the previous history', () => {
    const d = buildDeps({ messages: bigHistory(), compactionOpts: { keepRecent: 4 } });
    const before = JSON.parse(JSON.stringify(d.getMessages()));
    handleSlashCommand({ command: 'compact', args: 'go' }, d);
    handleSlashCommand({ command: 'compact', args: 'undo' }, d);
    expect(d.getMessages()).toEqual(before);
    expect(d.ledgers).toHaveLength(0);
    expect(d.replies[1]).toContain('undone');
  });

  it('undo with no ledger says so', () => {
    const d = buildDeps();
    handleSlashCommand({ command: 'compact', args: 'undo' }, d);
    expect(d.replies[0]).toContain('kuch nahi');
  });
});
