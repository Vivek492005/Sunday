// Tests for context/compaction.ts — transparent compaction + undo.
//
// Acceptance gates from the F4 spec:
//   1. Pinned constraint survives 3 compactions (100% retention).
//   2. Undo restores the message history byte-identical.
import { describe, expect, it } from 'vitest';
import {
  compact,
  editLedgerSummary,
  previewCompaction,
  trimToolOutput,
  undoCompaction,
} from './compaction.js';
import type { TrackedMessage } from './types.js';

function msg(id: string, role: 'user' | 'assistant' | 'system', text: string, extra: Partial<TrackedMessage> = {}): TrackedMessage {
  return { id, role, text, createdAt: Date.now(), ...extra };
}

function longConversation(): TrackedMessage[] {
  const out: TrackedMessage[] = [];
  out.push(msg('sys-1', 'system', 'You are Sunday.', { pinned: true }));
  for (let i = 0; i < 20; i += 1) {
    out.push(msg(`u-${i}`, 'user', `user question ${i} about the codebase`));
    out.push(msg(`a-${i}`, 'assistant', `assistant answer ${i} with some detail about the fix`));
  }
  return out;
}

describe('trimToolOutput', () => {
  it('leaves short outputs alone', () => {
    const r = trimToolOutput('short', 4000);
    expect(r.wasTrimmed).toBe(false);
    expect(r.trimmed).toBe('short');
  });

  it('trims long outputs keeping head and tail', () => {
    const text = `HEAD-${'x'.repeat(5000)}-TAIL`;
    const r = trimToolOutput(text, 1000);
    expect(r.wasTrimmed).toBe(true);
    expect(r.trimmed).toContain('HEAD-');
    expect(r.trimmed).toContain('-TAIL');
    expect(r.archivedChars).toBe(text.length);
  });
});

describe('previewCompaction', () => {
  it('never touches pinned messages and keeps the recent window', () => {
    // Multi-paragraph messages so the extractive summarizer (3 lines/msg)
    // actually compresses — mirrors real long-session content.
    const para = (i: number, who: string) =>
      Array.from({ length: 8 }, (_, l) => `${who} turn ${i} paragraph line ${l} with real substance about the codebase and the fix being discussed`).join('\n');
    const msgs: TrackedMessage[] = [
      msg('sys-1', 'system', 'You are Sunday.', { pinned: true }),
    ];
    for (let i = 0; i < 20; i += 1) {
      msgs.push(msg(`u-${i}`, 'user', para(i, 'user')));
      msgs.push(msg(`a-${i}`, 'assistant', para(i, 'assistant')));
    }
    const preview = previewCompaction(msgs, { keepRecent: 6 });
    expect(preview.protected).toContain('sys-1');
    expect(preview.toSummarize).not.toContain('sys-1');
    expect(preview.toSummarize.length).toBeGreaterThan(0);
    expect(preview.tokensAfter).toBeLessThan(preview.tokensBefore);
    expect(preview.draftSummary.length).toBeGreaterThan(0);
  });

  it('flags large tool outputs for trimming first', () => {
    const msgs = [
      msg('u-1', 'user', 'run tests'),
      msg('t-1', 'assistant', 'x'.repeat(9000), { toolOutput: true }),
    ];
    const preview = previewCompaction(msgs, { keepRecent: 10, trimThreshold: 4000 });
    expect(preview.toTrim).toContain('t-1');
    expect(preview.toSummarize).not.toContain('t-1');
  });
});

describe('compact', () => {
  it('archives tool outputs to artifacts with a stub reference', () => {
    const written: Record<string, string> = {};
    const msgs = [
      msg('u-1', 'user', 'run tests'),
      msg('t-1', 'assistant', `LOG:${'y'.repeat(9000)}`, { toolOutput: true }),
    ];
    const { messages, ledger } = compact(msgs, {
      keepRecent: 10,
      trimThreshold: 4000,
      writeArtifact: (dir, id, text) => {
        written[id] = text;
        return `${dir}/${id}.log`;
      },
    });
    expect(ledger.archivedOutputs).toHaveLength(1);
    expect(ledger.archivedOutputs[0].artifactPath).toContain('t-1.log');
    expect(written['t-1']).toContain('LOG:');
    const trimmed = messages.find((m) => m.id === 't-1')!;
    expect(trimmed.text).toContain('full output archived');
  });

  it('pinned constraint survives 3 compactions (100% retention)', () => {
    const PIN = 'NEVER touch src/auth — it is frozen.';
    let msgs: TrackedMessage[] = [
      msg('sys-1', 'system', `Constraints: ${PIN}`, { pinned: true }),
      ...Array.from({ length: 30 }, (_, i) =>
        msg(`u-${i}`, 'user', `question ${i}`),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        msg(`a-${i}`, 'assistant', `answer ${i}`),
      ),
    ];
    for (let round = 0; round < 3; round += 1) {
      const { messages } = compact(msgs, { keepRecent: 4 });
      msgs = messages;
      // After each compaction, add more turns so the next one has work to do.
      for (let i = 0; i < 8; i += 1) {
        msgs.push(msg(`r${round}-u-${i}`, 'user', `round ${round} question ${i}`));
        msgs.push(msg(`r${round}-a-${i}`, 'assistant', `round ${round} answer ${i}`));
      }
    }
    const pinned = msgs.filter((m) => m.pinned);
    expect(pinned.length).toBeGreaterThanOrEqual(1);
    expect(pinned.some((m) => m.text.includes(PIN))).toBe(true);
  });
});

describe('undoCompaction', () => {
  it('restores the message history byte-identical', () => {
    const original = longConversation();
    const snapshot = JSON.parse(JSON.stringify(original)) as TrackedMessage[];
    const { messages, ledger } = compact(original, { keepRecent: 6 });
    expect(messages).not.toEqual(snapshot); // compaction changed something
    const restored = undoCompaction(messages, ledger);
    expect(restored).toEqual(snapshot);
  });

  it('restores trimmed tool outputs when archived texts are provided', () => {
    const big = `LOG:${'z'.repeat(9000)}`;
    const msgs = [
      msg('u-1', 'user', 'run tests'),
      msg('t-1', 'assistant', big, { toolOutput: true }),
      ...Array.from({ length: 10 }, (_, i) => msg(`u2-${i}`, 'user', `q${i}`)),
    ];
    const { messages, ledger } = compact(msgs, {
      keepRecent: 4,
      trimThreshold: 100,
      writeArtifact: (_d, id, text) => `art://${id}`,
    });
    const restored = undoCompaction(messages, ledger, { 't-1': big });
    const t1 = restored.find((m) => m.id === 't-1')!;
    expect(t1.text).toBe(big);
  });
});

describe('editLedgerSummary', () => {
  it('lets the user edit the ledger summary', () => {
    const { ledger } = compact(longConversation(), { keepRecent: 6 });
    const updated = editLedgerSummary(ledger, 'my own summary');
    expect(updated.summary).toBe('my own summary');
    expect(updated.removed).toEqual(ledger.removed); // rest untouched
  });
});
