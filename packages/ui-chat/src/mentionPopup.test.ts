// Unit tests for the @-mention autocomplete controller. No DOM, no React.
import { describe, expect, it } from 'vitest';
import {
  MENTION_ITEMS,
  applyMentionInsert,
  filterMentionItems,
  mentionQueryAtCaret,
  moveSelection,
  type PopupState,
} from './mentionPopup.js';

describe('mentionQueryAtCaret', () => {
  it('detects a query right after @', () => {
    const text = 'look at @fi';
    expect(mentionQueryAtCaret(text, text.length)).toEqual({ start: 8, query: 'fi' });
  });

  it('detects a bare @ with an empty query', () => {
    const text = 'hello @';
    expect(mentionQueryAtCaret(text, text.length)).toEqual({ start: 6, query: '' });
  });

  it('returns undefined when the caret is not after a query', () => {
    expect(mentionQueryAtCaret('no mention here', 5)).toBeUndefined();
    // caret right after the completed word "file" + space: not a live query
    expect(mentionQueryAtCaret('@file x', 6)).toBeUndefined();
  });

  it('ignores email addresses', () => {
    const text = 'user@example.com';
    expect(mentionQueryAtCaret(text, text.length)).toBeUndefined();
  });

  it('ignores @ inside code spans', () => {
    const text = '`@fi';
    expect(mentionQueryAtCaret(text, text.length)).toBeUndefined();
  });

  it('requires a word boundary before the @', () => {
    const text = 'abc@fi';
    expect(mentionQueryAtCaret(text, text.length)).toBeUndefined();
  });
});

describe('filterMentionItems', () => {
  it('returns all items for an empty query', () => {
    expect(filterMentionItems('')).toHaveLength(MENTION_ITEMS.length);
  });

  it('prefers prefix matches', () => {
    const kinds = filterMentionItems('f').map((i) => i.kind);
    expect(kinds[0]).toBe('file');
    expect(kinds[1]).toBe('folder');
  });

  it('matches substrings after prefixes', () => {
    const kinds = filterMentionItems('dia').map((i) => i.kind);
    expect(kinds[0]).toBe('diagnostics');
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(filterMentionItems('zzz')).toEqual([]);
  });
});

describe('applyMentionInsert', () => {
  it('replaces the query with the insert text and places the caret after it', () => {
    const { text, caret } = applyMentionInsert('look @fi please', 5, 2, MENTION_ITEMS[0]!);
    expect(text).toBe('look @file  please');
    expect(caret).toBe(5 + '@file '.length);
  });
});

describe('moveSelection', () => {
  const state = (n: number): PopupState => ({
    items: MENTION_ITEMS.slice(0, n),
    selected: 0,
    anchor: 0,
  });

  it('moves down and wraps around', () => {
    expect(moveSelection(state(3), 1).selected).toBe(1);
    expect(moveSelection({ ...state(3), selected: 2 }, 1).selected).toBe(0);
  });

  it('moves up and wraps around', () => {
    expect(moveSelection(state(3), -1).selected).toBe(2);
  });

  it('leaves an empty list untouched', () => {
    expect(moveSelection(state(0), 1)).toEqual(state(0));
  });
});
