// sunday-agent — VS Code Native Chat Participant.
//
// Registers `@sunday` as a chat participant in VS Code's native chat,
// so users can invoke Sunday AI via `@sunday <prompt>` in the built-in
// Chat view. This complements (not replaces) Sunday's own chat webview.
//
// User request 2026-10-11: native chat shows "Chat setup failed" and only
// "Auto" in model picker. The participant gives users a working Sunday
// entry point in the native chat UI.

import * as vscode from 'vscode';
import { SUNDAY_MODELS, findSundayModel } from './sundayModels.js';

export const SUNDAY_PARTICIPANT_ID = 'sunday.agent';

/**
 * Sunday models available via the participant (shown in `/model` command).
 * Canonical list lives in sundayModels.ts — re-exported here for
 * backwards compatibility.
 */
export const SUNDAY_PARTICIPANT_MODELS = SUNDAY_MODELS.map((m) => ({
  id: m.id,
  label: m.label,
  ref: m.ref,
}));

export interface ChatParticipantDeps {
  /** Returns the HostBridge for sending chat requests (may be undefined if sidecar not ready). */
  getBridge: () => { chatStream?: (req: unknown) => AsyncIterable<{ delta?: string; text?: string }> } | undefined;
  /** Currently selected model id (from workspace state). */
  getSelectedModel: () => string;
  log: (msg: string) => void;
}

/**
 * Registers the `@sunday` chat participant.
 * Users type `@sunday <prompt>` in VS Code's native chat.
 */
export function registerSundayChatParticipant(
  context: vscode.ExtensionContext,
  deps: ChatParticipantDeps,
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(SUNDAY_PARTICIPANT_ID, async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ) => {
    const bridge = deps.getBridge() as unknown as {
      chat?: (req: unknown) => AsyncIterable<{ delta?: string; text?: string }>;
    } | undefined;

    // Handle /model command to list/switch models
    if (request.command === 'model') {
      const models = SUNDAY_PARTICIPANT_MODELS.map((m) => `- **${m.label}**`).join('\n');
      stream.markdown(`### ☀️ Sunday Models\n\n${models}\n\nModel selection UI coming soon — currently using Auto.`);
      return;
    }

    if (!bridge?.chat) {
      stream.markdown('⚠️ Sunday agent is starting up. Please wait a moment and try again.');
      return;
    }

    const modelId = deps.getSelectedModel();
    const modelEntry = findSundayModel(modelId);
    const modelRef = modelEntry.ref;

    // Build message history from the request + context
    const messages: Array<{ role: string; content: string }> = [];
    for (const h of chatContext.history) {
      if (h instanceof vscode.ChatRequestTurn) {
        messages.push({ role: 'user', content: h.prompt });
      } else if (h instanceof vscode.ChatResponseTurn) {
        const text = h.response.map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : '')).join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    }
    messages.push({ role: 'user', content: request.prompt });

    stream.progress(`☀️ Sunday (${modelEntry.label}) thinking…`);

    try {
      const chatStream = bridge.chat({
        model: modelRef,
        messages,
        stream: true,
      }) as AsyncIterable<{ delta?: string; text?: string }>;

      for await (const chunk of chatStream) {
        if (token.isCancellationRequested) break;
        const text = chunk.delta ?? chunk.text ?? '';
        if (text) stream.markdown(text);
      }
    } catch (err) {
      deps.log(`chat participant failed: ${(err as Error).message}`);
      stream.markdown(`❌ Sunday chat failed: ${(err as Error).message}`);
    }
  });

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'sunday-icon.svg');
  participant.followupProvider = {
    provideFollowups(
      _result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.ChatFollowup[]> {
      return [
        { prompt: 'Explain this code', label: '💡 Explain' },
        { prompt: 'Find bugs in this code', label: '🐛 Find bugs' },
        { prompt: 'Optimize this code', label: '⚡ Optimize' },
      ];
    },
  };

  // Register /model command
  // (declared in package.json under chatParticipants.commands)

  deps.log('chat: @sunday participant registered');
  return participant;
}
