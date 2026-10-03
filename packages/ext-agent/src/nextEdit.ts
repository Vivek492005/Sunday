// sunday-agent — next-edit suggestions (Phase 8, experimental).
//
// After the user makes a rename-like edit (one identifier swapped for
// another), predict the *next* edit: the following occurrence of the old
// identifier, offered as a CodeLens ("Sunday: rename 'x' → 'y' here").
// Accepting it applies the edit, which chains to the next occurrence until
// none remain.
//
// The prediction core (detectRename / findNextOccurrence / predictNextEdit)
// is pure and unit-tested. Only NextEditTracker / NextEditCodeLensProvider
// touch the `vscode` API.
//
// Gated by `sunday.nextEdit.enabled` (default false). This module never
// touches the completion pipeline, so a bug here cannot break ghost text.

import * as vscode from 'vscode';

/** A predicted follow-up edit. Plain data — no vscode types, for testability. */
export interface NextEditSuggestion {
  /** Document URI string. */
  uri: string;
  /** Document version the suggestion was computed against. */
  version: number;
  /** 0-based range of the old identifier's next occurrence. */
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  oldText: string;
  newText: string;
  reason: string;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/**
 * Minimum identifier length that triggers rename propagation. Single-letter
 * identifiers (loop vars, `e`, …) would be far too noisy.
 */
const MIN_IDENT_LEN = 2;

export interface NextEditConfig {
  enabled: boolean;
}

export function readNextEditConfig(): NextEditConfig {
  const cfg = vscode.workspace.getConfiguration('sunday.nextEdit');
  return { enabled: cfg.get<boolean>('enabled', false) };
}

/**
 * Decide whether a before/after snippet pair looks like a rename:
 * one identifier swapped for a different identifier.
 */
export function detectRename(
  beforeSnippet: string,
  afterSnippet: string,
): { oldName: string; newName: string } | null {
  if (beforeSnippet.length < MIN_IDENT_LEN) return null;
  if (!IDENT_RE.test(beforeSnippet) || !IDENT_RE.test(afterSnippet)) return null;
  if (beforeSnippet === afterSnippet) return null;
  return { oldName: beforeSnippet, newName: afterSnippet };
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function offsetToPosition(
  text: string,
  offset: number,
): { line: number; character: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: clamped - lineStart };
}

/**
 * Find the next whole-word occurrence of `name` at or after `fromOffset`,
 * wrapping to the start of the document when there is none later.
 * Returns the match offset, or null when `name` occurs nowhere.
 */
export function findNextOccurrence(
  text: string,
  name: string,
  fromOffset: number,
): number | null {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
  re.lastIndex = Math.max(0, fromOffset);
  const forward = re.exec(text);
  if (forward) return forward.index;
  re.lastIndex = 0;
  const wrapped = re.exec(text);
  return wrapped ? wrapped.index : null;
}

export interface RenamePredictionInput {
  /** Full document text BEFORE the change. */
  beforeText: string;
  /** Full document text AFTER the change. */
  afterText: string;
  /** Offset (before-text coordinates) of the replaced range. */
  changeOffset: number;
  /** Length of the replaced range (before-text). */
  changeLength: number;
  /** Replacement text. */
  changeText: string;
  uri: string;
  version: number;
}

/**
 * Core prediction: given a single document change, return a next-edit
 * suggestion when the change looks like a rename and the old identifier
 * still occurs elsewhere in the document.
 */
export function predictNextEdit(input: RenamePredictionInput): NextEditSuggestion | null {
  const { beforeText, afterText, changeOffset, changeLength, changeText, uri, version } =
    input;
  const beforeSnippet = beforeText.slice(changeOffset, changeOffset + changeLength);
  const rename = detectRename(beforeSnippet, changeText);
  if (!rename) return null;
  // Search just past the applied change, in after-text coordinates.
  const afterChangeEnd = changeOffset + changeText.length;
  const nextOffset = findNextOccurrence(afterText, rename.oldName, afterChangeEnd);
  if (nextOffset === null) return null;
  const start = offsetToPosition(afterText, nextOffset);
  const end = offsetToPosition(afterText, nextOffset + rename.oldName.length);
  return {
    uri,
    version,
    range: { start, end },
    oldText: rename.oldName,
    newText: rename.newName,
    reason: `Rename '${rename.oldName}' → '${rename.newName}'`,
  };
}

/** Minimal surface the tracker needs from the lens provider (test seam). */
export interface SuggestionSink {
  set(uri: string, suggestion: NextEditSuggestion | null): void;
  get(uri: string): NextEditSuggestion | undefined;
}

export class NextEditCodeLensProvider
  implements vscode.CodeLensProvider, SuggestionSink
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this.emitter.event;
  private readonly lenses = new Map<string, NextEditSuggestion>();

  set(uri: string, suggestion: NextEditSuggestion | null): void {
    if (suggestion) this.lenses.set(uri, suggestion);
    else this.lenses.delete(uri);
    this.emitter.fire();
  }

  get(uri: string): NextEditSuggestion | undefined {
    return this.lenses.get(uri);
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!readNextEditConfig().enabled) return [];
    const s = this.lenses.get(document.uri.toString());
    if (!s || s.version !== document.version) return [];
    const range = new vscode.Range(
      s.range.start.line,
      s.range.start.character,
      s.range.end.line,
      s.range.end.character,
    );
    return [
      new vscode.CodeLens(range, {
        title: `Sunday: rename '${s.oldText}' → '${s.newText}' here`,
        command: 'sunday.nextEdit.apply',
        arguments: [s.uri],
      }),
    ];
  }
}

/**
 * Tracks document text snapshots so each change event can be analyzed as
 * before/after. Single rename-like changes produce a pending suggestion;
 * anything else clears it.
 */
export class NextEditTracker {
  private readonly snapshots = new Map<string, string>();

  constructor(private readonly sink: SuggestionSink) {}

  start(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        this.snapshots.set(doc.uri.toString(), doc.getText());
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = doc.uri.toString();
        this.snapshots.delete(key);
        this.sink.set(key, null);
      }),
    );
    for (const doc of vscode.workspace.textDocuments ?? []) {
      this.snapshots.set(doc.uri.toString(), doc.getText());
    }
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    const key = e.document.uri.toString();
    const afterText = e.document.getText();
    const beforeText = this.snapshots.get(key);
    this.snapshots.set(key, afterText);
    if (!readNextEditConfig().enabled) {
      this.sink.set(key, null);
      return;
    }
    if (beforeText === undefined || e.contentChanges.length !== 1) {
      this.sink.set(key, null);
      return;
    }
    const change = e.contentChanges[0];
    const suggestion = predictNextEdit({
      beforeText,
      afterText,
      changeOffset: change.rangeOffset,
      changeLength: change.rangeLength,
      changeText: change.text,
      uri: key,
      version: e.document.version,
    });
    this.sink.set(key, suggestion);
  }
}

/**
 * Register the experimental next-edit feature: CodeLens provider, apply
 * command, and edit tracker. All disposables go to `context.subscriptions`.
 * Safe to call unconditionally — everything no-ops unless
 * `sunday.nextEdit.enabled` is true.
 */
export function registerNextEdit(context: vscode.ExtensionContext): NextEditCodeLensProvider {
  const provider = new NextEditCodeLensProvider();
  const tracker = new NextEditTracker(provider);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ pattern: '**' }, provider),
    vscode.commands.registerCommand(
      'sunday.nextEdit.apply',
      async (uri: string | undefined) => {
        if (typeof uri !== 'string') return;
        const s = provider.get(uri);
        if (!s || !readNextEditConfig().enabled) return;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        // Re-validate: never apply a suggestion computed for an older version.
        if (doc.version !== s.version) return;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          doc.uri,
          new vscode.Range(
            s.range.start.line,
            s.range.start.character,
            s.range.end.line,
            s.range.end.character,
          ),
          s.newText,
        );
        await vscode.workspace.applyEdit(edit);
        // The resulting change event re-predicts: it chains to the following
        // occurrence, or clears the suggestion when none remain.
      },
    ),
  );
  tracker.start(context);
  return provider;
}
