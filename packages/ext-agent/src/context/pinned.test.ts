// Tests for context/pinned.ts — pins are never lost.
import { describe, expect, it } from 'vitest';
import { PinnedStore } from './pinned.js';

describe('PinnedStore', () => {
  it('pins and lists facts oldest-first', () => {
    const s = new PinnedStore();
    const a = s.pinFact('never touch src/auth');
    const b = s.pinFact('use tabs, not spaces');
    expect(s.listPinned().map((f) => f.id)).toEqual([a.id, b.id]);
  });

  it('rejects empty pins', () => {
    const s = new PinnedStore();
    expect(() => s.pinFact('   ')).toThrow();
  });

  it('unpins by id', () => {
    const s = new PinnedStore();
    const f = s.pinFact('x');
    expect(s.unpinFact(f.id)).toBe(true);
    expect(s.unpinFact(f.id)).toBe(false);
    expect(s.listPinned()).toHaveLength(0);
  });

  it('renders a pinned block for model injection', () => {
    const s = new PinnedStore();
    expect(s.renderPinnedBlock()).toBe('');
    s.pinFact('never touch src/auth');
    const block = s.renderPinnedBlock();
    expect(block).toContain('PINNED FACTS');
    expect(block).toContain('never touch src/auth');
  });

  it('persists on change when a persist fn is given', () => {
    let saved: unknown = null;
    const s = new PinnedStore({ persist: (facts) => { saved = facts; } });
    s.pinFact('hello');
    expect(Array.isArray(saved)).toBe(true);
    expect((saved as { text: string }[])[0].text).toBe('hello');
  });

  it('loads previously persisted facts', () => {
    const s = new PinnedStore();
    s.load([{ id: 'pin-1', text: 'abc', pinnedBy: 'user', createdAt: 1 }]);
    expect(s.listPinned()).toHaveLength(1);
  });
});
