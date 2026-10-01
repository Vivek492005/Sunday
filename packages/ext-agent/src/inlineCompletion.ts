// sunday-agent — ghost-text inline completions (Part B).
// Thin VS Code InlineCompletionItemProvider: extracts prefix/suffix around
// the cursor and asks sundayd's `completion/complete` RPC for a completion.
// All smarts (debounce, coalescing, cache, provider call) live in the
// sidecar — this module never touches the network or @sunday/gateway
// (which is not a dependency of the extension).

import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';

/** Characters of context sent around the cursor. */
const PREFIX_CHARS = 2000;
const SUFFIX_CHARS = 500;

/** Default completion model: fast/cheap. Mirrors sundayd's default. */
export const DEFAULT_COMPLETION_MODEL = 'groq:llama-3.1-8b-instant';

export interface CompletionConfig {
  enabled: boolean;
  debounceMs: number;
  model: string;
}

export function readCompletionConfig(): CompletionConfig {
  const cfg = vscode.workspace.getConfiguration('sunday.completion');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    debounceMs: cfg.get<number>('debounceMs', 75),
    model: cfg.get<string>('model', DEFAULT_COMPLETION_MODEL),
  };
}

/**
 * Register the ghost-text provider for all languages. Returns the
 * disposable (also pushed into `context.subscriptions`).
 */
export function registerInlineCompletion(
  context: vscode.ExtensionContext,
  bridge: HostBridge,
): vscode.Disposable {
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _ctx, token) {
      const cfg = readCompletionConfig();
      if (!cfg.enabled || token.isCancellationRequested) return [];
      try {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const prefix = text.slice(Math.max(0, offset - PREFIX_CHARS), offset);
        const suffix = text.slice(offset, offset + SUFFIX_CHARS);
        if (!prefix.trim()) return [];
        const res = await bridge.completionComplete({
          uri: document.uri.toString(),
          position: { line: position.line, character: position.character },
          prefix,
          suffix: suffix || undefined,
          docVersion: document.version,
          model: cfg.model || undefined,
        });
        if (token.isCancellationRequested || res.cancelled || !res.completion) {
          return [];
        }
        return [
          new vscode.InlineCompletionItem(
            res.completion,
            new vscode.Range(position, position),
          ),
        ];
      } catch {
        // Completions must never break typing: degrade to no ghost text.
        return [];
      }
    },
  };
  const disposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    provider,
  );
  context.subscriptions.push(disposable);
  return disposable;
}
