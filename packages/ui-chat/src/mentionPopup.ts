// @-mention autocomplete controller for the chat composer.
//
// Framework-free and DOM-free (like chatClient.ts): all query detection,
// filtering, keyboard navigation, and insertion logic lives here so it is
// unit-testable with plain vitest. The React layer (MentionPopup.tsx /
// Composer.tsx) is a thin shell over these functions.

export interface MentionItem {
  kind: string;
  /** Display label, e.g. `@file`. */
  label: string;
  /** Argument hint, e.g. `<path…>`. Empty for bare kinds. */
  hint: string;
  /** Text inserted into the composer when accepted (includes trailing space). */
  insert: string;
  description: string;
}

export const MENTION_ITEMS: MentionItem[] = [
  { kind: 'file', label: '@file', hint: '<path…>', insert: '@file ', description: 'Attach a file\u2019s contents' },
  { kind: 'folder', label: '@folder', hint: '<path…>', insert: '@folder ', description: 'Attach a directory listing' },
  { kind: 'symbol', label: '@symbol', hint: '<name…>', insert: '@symbol ', description: 'Attach a workspace symbol\u2019s definition' },
  { kind: 'selection', label: '@selection', hint: '', insert: '@selection ', description: 'Attach the current editor selection' },
  { kind: 'terminal', label: '@terminal', hint: '', insert: '@terminal ', description: 'Attach active terminal info' },
  { kind: 'diagnostics', label: '@diagnostics', hint: '', insert: '@diagnostics ', description: 'Attach workspace problems' },
  { kind: 'git-diff', label: '@git-diff', hint: '', insert: '@git-diff ', description: 'Attach staged + unstaged diff' },
  { kind: 'web', label: '@web', hint: '<url…>', insert: '@web ', description: 'Reference a web page (agent fetches it)' },
  { kind: 'docs', label: '@docs', hint: '<skill…>', insert: '@docs ', description: 'Attach a Sunday skill\u2019s docs' },
];

export interface MentionQuery {
  /** Index of the `@` that started the query. */
  start: number;
  /** Text after the `@` up to the caret (may be empty). */
  query: string;
}

function isQueryChar(ch: string): boolean {
  return /[a-zA-Z0-9_-]/.test(ch);
}

/** Best-effort check: is `index` inside a backtick code span? Scans the
 *  current line for an odd number of backticks before the index, and checks
 *  for an unclosed ``` fence above. */
function insideCodeSpan(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineBackticks = (before.slice(lineStart).match(/`/g) ?? []).length;
  if (lineBackticks % 2 === 1) return true;
  const fences = (before.match(/```/g) ?? []).length;
  return fences % 2 === 1;
}

/**
 * If the caret sits right after `@` + word chars (e.g. `@fi|`), return the
 * query; otherwise undefined. Ignores `@` inside code spans and email-like
 * `user@x` sequences (the `@` must be at the start or preceded by a
 * non-word, non-`@` character).
 */
export function mentionQueryAtCaret(text: string, caret: number): MentionQuery | undefined {
  let i = caret - 1;
  while (i >= 0 && isQueryChar(text[i]!)) i -= 1;
  if (i < 0 || text[i] !== '@') return undefined;
  if (i > 0 && /[\w@]/.test(text[i - 1]!)) return undefined;
  if (insideCodeSpan(text, i)) return undefined;
  return { start: i, query: text.slice(i + 1, caret) };
}

/** Filter the mention catalog by query: prefix matches first, then
 *  substring matches. Empty query returns everything. */
export function filterMentionItems(query: string): MentionItem[] {
  const q = query.toLowerCase();
  if (!q) return [...MENTION_ITEMS];
  const prefix = MENTION_ITEMS.filter((it) => it.kind.startsWith(q));
  const rest = MENTION_ITEMS.filter((it) => !it.kind.startsWith(q) && it.kind.includes(q));
  return [...prefix, ...rest];
}

export interface PopupState {
  items: MentionItem[];
  selected: number;
  /** Index of the `@` in the composer text. */
  anchor: number;
}

/** Replace the `@query` at `anchor` with the item's insert text and return
 *  the new text plus the caret position right after the insertion. */
export function applyMentionInsert(
  text: string,
  anchor: number,
  queryLength: number,
  item: MentionItem,
): { text: string; caret: number } {
  const end = anchor + 1 + queryLength;
  const next = text.slice(0, anchor) + item.insert + text.slice(end);
  return { text: next, caret: anchor + item.insert.length };
}

/** Move the highlight, wrapping around the list. */
export function moveSelection(state: PopupState, delta: 1 | -1): PopupState {
  const n = state.items.length;
  if (n === 0) return state;
  return { ...state, selected: (state.selected + delta + n) % n };
}
