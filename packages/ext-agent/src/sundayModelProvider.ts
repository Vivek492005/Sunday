// sunday-agent — Sunday Language Model Provider.
//
// Registers Sunday as a `vscode.lm` chat model provider (vendor "sunday").
// This is the permanent fix for the native VS Code chat depending on
// GitHub Copilot: with Sunday's own models registered, the built-in Chat
// view works WITHOUT Copilot — no more "Chat setup failed" /
// "GitHub.copilot-chat cannot be installed" errors.
//
// User report 2026-10-11 (Beta.3 screenshot): native chat showed the
// Copilot-install error dialog because no language model provider existed.
// API: `vscode.lm.registerLanguageModelChatProvider` — stable in this VS
// Code version (vscode.d.ts), NOT behind a proposed-API gate.

import * as vscode from 'vscode';
import { SUNDAY_MODELS, findSundayModel, type SundayModel } from './sundayModels.js';

/**
 * The 4 Sunday models — canonical list lives in sundayModels.ts.
 * Re-exported here for backwards compatibility.
 */
export const SUNDAY_LM_MODELS: ReadonlyArray<SundayModel> = SUNDAY_MODELS;

export interface ModelProviderDeps {
  /** Returns the HostBridge for sending chat requests (may be undefined if sidecar not ready). */
  getBridge: () => { chat?: (req: unknown) => AsyncIterable<{ delta?: string; text?: string }> } | undefined;
  log: (msg: string) => void;
}

/** Rough token estimate when the model can't count exactly. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Registers Sunday as a language-model chat provider.
 * After this, VS Code's native Chat shows Sunday models in its model
 * picker and chat works with zero Copilot dependency.
 */
export function registerSundayModelProvider(
  context: vscode.ExtensionContext,
  deps: ModelProviderDeps,
): vscode.Disposable {
  const provider: vscode.LanguageModelChatProvider = {
    async provideLanguageModelChatInformation(
      _options: vscode.PrepareLanguageModelChatModelOptions,
      _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelChatInformation[]> {
      return SUNDAY_LM_MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        family: m.family,
        version: m.version,
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        tooltip: m.tooltip,
        // Capabilities: these models support tools via the gateway.
        capabilities: { toolCalling: true, imageInput: false } as vscode.LanguageModelChatInformation['capabilities'],
      }));
    },

    async provideLanguageModelChatResponse(
      model: vscode.LanguageModelChatInformation,
      messages: readonly vscode.LanguageModelChatRequestMessage[],
      _options: vscode.ProvideLanguageModelChatResponseOptions,
      progress: vscode.Progress<vscode.LanguageModelResponsePart>,
      ct: vscode.CancellationToken,
    ): Promise<void> {
      const entry = findSundayModel(model.id);
      const bridge = deps.getBridge();

      if (!bridge?.chat) {
        progress.report(new vscode.LanguageModelTextPart(
          '⚠️ Sunday agent abhi start ho raha hai. Ek pal ruko aur phir se try karo.',
        ));
        return;
      }

      // Convert VS Code chat messages to the bridge's message format.
      const history: Array<{ role: string; content: string }> = messages.map((msg) => {
        const text = msg.content
          .map((part) => {
            if (part instanceof vscode.LanguageModelTextPart) return part.value;
            return '';
          })
          .join('');
        return { role: msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user', content: text };
      });

      try {
        const stream = bridge.chat({ model: entry.ref, messages: history });
        for await (const chunk of stream) {
          if (ct.isCancellationRequested) break;
          const delta = chunk.delta ?? chunk.text ?? '';
          if (delta) progress.report(new vscode.LanguageModelTextPart(delta));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log(`model provider: chat stream failed: ${msg}`);
        progress.report(new vscode.LanguageModelTextPart(`\n\n⚠️ Sunday se jawab nahi mil paya: ${msg}`));
      }
    },

    async provideTokenCount(
      _model: vscode.LanguageModelChatInformation,
      text: string | vscode.LanguageModelChatRequestMessage,
      _token: vscode.CancellationToken,
    ): Promise<number> {
      if (typeof text === 'string') return estimateTokens(text);
      const joined = text.content
        .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
        .join('');
      return estimateTokens(joined);
    },
  };

  const disposable = vscode.lm.registerLanguageModelChatProvider('sunday', provider);
  context.subscriptions.push(disposable);
  deps.log('lm: Sunday model provider registered (vendor "sunday", 4 models)');
  return disposable;
}
