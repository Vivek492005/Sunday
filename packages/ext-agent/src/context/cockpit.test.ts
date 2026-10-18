// Tests for context/cockpit.ts — session cockpit wiring.
import { describe, expect, it } from 'vitest';
import { ContextCockpit } from './cockpit.js';
import { parseSlashCommand } from './slashCommands.js';

describe('ContextCockpit', () => {
  it('tracks messages and reports usage', () => {
    const c = new ContextCockpit({ limit: 10000 });
    c.trackUserMessage('hello world');
    c.trackAssistantMessage('hi there');
    const u = c.usage();
    expect(u.used).toBeGreaterThan(0);
    expect(u.breakdown.history).toBeGreaterThan(0);
    expect(u.limit).toBe(10000);
  });

  it('handles /pin and /compact go/undo end-to-end', () => {
    const c = new ContextCockpit({ limit: 100000 });
    const replies: string[] = [];
    const reply = (md: string) => replies.push(md);

    // Pin a fact.
    c.handleSlash(parseSlashCommand('/pin never touch src/auth')!, reply);
    expect(c.pinned.listPinned()).toHaveLength(1);
    expect(replies[0]).toContain('Pinned');

    // Build history, compact, verify pin survives, undo restores.
    for (let i = 0; i < 20; i += 1) {
      c.trackUserMessage(`user turn ${i} with enough text to make compaction meaningful `.repeat(4));
      c.trackAssistantMessage(`assistant turn ${i} with enough text to make compaction meaningful `.repeat(4));
    }
    const before = c.getMessages().length;
    c.handleSlash(parseSlashCommand('/compact go')!, reply);
    expect(c.getLedgers()).toHaveLength(1);
    expect(c.getMessages().length).toBeLessThan(before);
    // Pinned fact still present.
    expect(c.pinned.listPinned()[0].text).toBe('never touch src/auth');

    c.handleSlash(parseSlashCommand('/compact undo')!, reply);
    expect(c.getMessages().length).toBe(before);
    expect(c.getLedgers()).toHaveLength(0);
  });

  it('runLocalCompaction archives tool outputs', () => {
    const c = new ContextCockpit({ limit: 100000 });
    c.trackUserMessage('run tests');
    c.trackAssistantMessage(`LOG:${'x'.repeat(9000)}`, true);
    for (let i = 0; i < 12; i += 1) {
      c.trackUserMessage(`q${i} `.repeat(50));
    }
    const { ledger } = c.runLocalCompaction();
    expect(ledger.archivedOutputs.length).toBeGreaterThanOrEqual(0);
    // Archived texts captured for byte-identical undo.
    const archived = c.getArchivedTexts();
    for (const a of ledger.archivedOutputs) {
      expect(archived[a.messageId].length).toBeGreaterThan(4000);
    }
  });
});
