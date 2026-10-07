// sunday-agent — Proactive Mode (F4).
//
// V1 is observe + report only (no auto-edits, no auto-runs — safety first).
//
// When `sunday.proactive.enabled` is true, this module:
//  - tracks last user activity via `onDidChangeTextDocument`,
//  - on save of a .ts/.tsx/.js file, waits 1s (debounced), then collects
//    `vscode.languages.getDiagnostics(doc.uri)` and surfaces the problem
//    count in a status-bar item: `$(sparkle) Proactive: checking <file>`.
// The user can switch the mode off at any time via the config flag.
//
// The config schema is NOT declared in package.json here (another worker owns
// that file) — `isProactiveEnabled` reads `vscode.workspace.getConfiguration`
// defensively and defaults to false when the key is absent.

import * as vscode from 'vscode';

// -- pure helpers ----------------------------------------------------------------

/** Config keys (read defensively — schema may not exist yet in package.json). */
const CONFIG_SECTION = 'sunday';
const CONFIG_KEY = 'proactive.enabled';

/**
 * Resolve whether proactive mode is enabled from a raw config value.
 * Any non-true value (undefined, false, junk) means disabled.
 */
export function isProactiveEnabled(raw: unknown): boolean {
  return raw === true;
}

/** Read the enabled flag from the workspace configuration, defaulting to false. */
export function readProactiveEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = cfg.get<unknown>(CONFIG_KEY);
  return isProactiveEnabled(raw);
}

/** File extensions that trigger a proactive diagnostic check on save. */
const WATCHED_EXTENSIONS = new Set(['.ts', '.tsx', '.js']);

/**
 * True when the saved document should trigger a proactive check:
 * watched extension (.ts/.tsx/.js) and a real file scheme.
 */
export function shouldCheckOnSave(fileName: string, scheme: string): boolean {
  if (scheme !== 'file') return false;
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return false;
  return WATCHED_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

/**
 * Summarize a diagnostics array into error/warning counts for status display.
 * Pure so it can be unit tested without the vscode API.
 */
export function summarizeDiagnostics(
  diagnostics: ReadonlyArray<{ severity?: number | undefined }>,
): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === 0) errors += 1; // DiagnosticSeverity.Error
    else if (d.severity === 1) warnings += 1; // DiagnosticSeverity.Warning
  }
  return { errors, warnings };
}

/** Status-bar text shown while a file is being checked. */
export function checkingText(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return `$(sparkle) Proactive: checking ${base}`;
}

/** Status-bar text shown after diagnostics are collected. */
export function resultText(fileName: string, errors: number, warnings: number): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  if (errors === 0 && warnings === 0) return `$(check) Proactive: ${base} clean`;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return `$(sparkle) Proactive: ${base} — ${parts.join(', ')}`;
}

// -- registration ----------------------------------------------------------------

export interface ProactiveModeState {
  /** Timestamp (ms) of the last observed user text change. */
  lastActivityAt: number;
}

/**
 * Register proactive mode. Returns a disposable that tears down the listeners
 * and status-bar item. If the config flag is off, returns a no-op disposable.
 */
export function registerProactiveMode(context: vscode.ExtensionContext): vscode.Disposable {
  if (!readProactiveEnabled()) {
    return { dispose: () => undefined };
  }

  const state: ProactiveModeState = { lastActivityAt: Date.now() };
  const disposables: vscode.Disposable[] = [];

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = 'Sunday Proactive Mode';
  disposables.push(statusBar);

  // Track user activity for idle detection (shared with sundayd policy).
  disposables.push(
    vscode.workspace.onDidChangeTextDocument(() => {
      state.lastActivityAt = Date.now();
    }),
  );

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  disposables.push({
    dispose: () => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    },
  });

  disposables.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      state.lastActivityAt = Date.now();
      if (!shouldCheckOnSave(doc.fileName, doc.uri.scheme)) return;

      statusBar.text = checkingText(doc.fileName);
      statusBar.show();

      // Debounce: let the language service settle before reading diagnostics.
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const diagnostics = vscode.languages.getDiagnostics(doc.uri);
        const { errors, warnings } = summarizeDiagnostics(diagnostics);
        statusBar.text = resultText(doc.fileName, errors, warnings);
        statusBar.tooltip = 'Sunday proactive check — diagnostics only, no changes made';
        statusBar.show();
      }, 1000);
    }),
  );

  context.subscriptions.push(...disposables);
  return vscode.Disposable.from(...disposables);
}
