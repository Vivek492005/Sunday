// sunday-agent — Inline Edit (command `sunday.inlineEdit`, Ctrl+I / Cmd+I).
//
// Flow: (1) capture the active selection (or the whole file when the selection
// is empty); (2) ask for a natural-language instruction via an input box;
// (3) send instruction + code to sundayd and await the rewritten block;
// (4) write the proposal to an untitled temp doc; (5) open vscode.diff for
// Accept/Reject review; (6) Accept → apply via `editor.edit()`; Reject → close.
//
// REUSE DECISION — why there is no new `edit/rewrite` RPC:
// `chat/send` already expresses "return rewritten code": the constrained
// prompt built by `buildEditPrompt()` binds the agent to output-only behavior
// (full rewritten block, no prose), and the turn streams back as text-deltas
// which we accumulate until `turn-end`. A dedicated RPC would duplicate the
// agent loop (session plumbing, retries, model routing, provider relay)
// across `@sunday/protocol` and sundayd for no functional gain. The edit runs
// in its own edit-scoped session so it never pollutes the chat history.
//
// POLICY DECISION — why `editor.edit()` after Accept is allowed:
// The write is *user-confirmed*: the exact bytes that will be written are shown
// in the vscode.diff preview before anything changes, and the user explicitly
// clicks "Accept". The extension never writes agent output to a workspace file
// without that confirmation. The write is also scoped to the range the user
// selected (or the whole file when nothing is selected), and the agent is
// instructed to return code only, so no unreviewed tool side effects occur.

import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';

export interface InlineEditDeps {
  /** Current bridge, if the sidecar is up. */
  getBridge: () => HostBridge | undefined;
  /** Ensure the sidecar is ready; shows UI on failure (extension.ts wires this). */
  ensureBridge: () => Promise<HostBridge | undefined>;
  log: (msg: string) => void;
}

const COMMAND_ID = 'sunday.inlineEdit';

// -- pure helpers ----------------------------------------------------------------

/**
 * Build the constrained rewrite-only prompt sent to sundayd via `chat/send`.
 * The instruction is inlined verbatim so the agent knows exactly what to do;
 * the RULES block binds it to output-only behavior so `extractRewrittenCode`
 * has a predictable reply shape.
 */
export function buildEditPrompt(instruction: string, code: string, languageId: string): string {
  return [
    'You are a code rewriting assistant. Rewrite ONLY the provided code block according to the instruction below.',
    '',
    'RULES:',
    '- Return the FULL rewritten code block, not a diff, excerpt, or summary.',
    '- Output code only — no explanations, no markdown fences, no surrounding prose.',
    `- Preserve the language (${languageId}); keep unrelated code unchanged.`,
    '- If the instruction cannot be applied, return the original block unchanged.',
    '',
    'INSTRUCTION:',
    instruction.trim(),
    '',
    `CODE (${languageId}):`,
    code,
  ].join('\n');
}

const FENCE_RE = /```[a-zA-Z0-9+#-]*\r?\n([\s\S]*?)\r?\n```/;

/**
 * Extract raw rewritten code from an agent reply. Strips the first fenced
 * code block (```lang … ```); passes plain text through unchanged.
 */
export function extractRewrittenCode(agentReply: string): string {
  const m = FENCE_RE.exec(agentReply);
  if (m) return m[1].trim();
  return agentReply.trim();
}

/**
 * The target range for the rewrite: the selection, or the whole document
 * when the selection is empty.
 */
export function computeTargetRange(
  doc: vscode.TextDocument,
  selection: vscode.Selection,
): vscode.Range {
  return selection.isEmpty ? new vscode.Range(0, 0, doc.lineCount, 0) : selection;
}

/** Apply `newText` over `range` in the given editor. Resolves to the edit outcome. */
export async function applyReplacement(
  editor: vscode.TextEditor,
  range: vscode.Range,
  newText: string,
): Promise<boolean> {
  return editor.edit((editBuilder) => {
    editBuilder.replace(range, newText);
  });
}

// -- turn plumbing ---------------------------------------------------------------

/** Accumulate text-deltas for one turn until `turn-end`; reject on `turn-error`.
 * Cancelling the token rejects the wait and stops the daemon turn. */
function awaitTurnText(
  bridge: HostBridge,
  turnId: string,
  token?: vscode.CancellationToken,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      cancelSub?.dispose();
      fn();
    };
    const unsubscribe = bridge.onChatEvent((n) => {
      if (n.turnId !== turnId) return;
      const e = n.event;
      if (e.type === 'text-delta') {
        text += e.delta;
      } else if (e.type === 'turn-end') {
        if (e.finishReason === 'stop') done(() => resolve(text));
        else done(() => reject(new Error(`Sunday turn ended: ${e.finishReason}`)));
      } else if (e.type === 'turn-error') {
        done(() => reject(new Error(`Sunday turn failed (${e.code}): ${e.message}`)));
      }
      // tool-call / tool-result / usage events are ignored: the constrained
      // prompt binds the agent to text output only.
    });
    const cancelSub = token?.onCancellationRequested(() => {
      void bridge.cancelActiveTurn().catch(() => undefined);
      done(() => reject(new Error('Sunday Inline Edit cancelled.')));
    });
  });
}

/** Send the rewrite turn in an edit-scoped session and return the raw reply text. */
async function requestRewrite(
  bridge: HostBridge,
  prompt: string,
  deps: InlineEditDeps,
  token: vscode.CancellationToken,
): Promise<string> {
  const { session } = await bridge.sessionCreate({ title: 'Sunday Inline Edit' });
  deps.log(`inline edit: session ${session.id}`);
  const { turnId } = await bridge.chatSend({ sessionId: session.id, message: prompt });
  deps.log(`inline edit: turn ${turnId}`);
  return awaitTurnText(bridge, turnId, token);
}

// -- command ---------------------------------------------------------------------

/** Full command implementation; exported for tests (registerInlineEdit wires it). */
export async function runInlineEdit(deps: InlineEditDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Sunday Inline Edit: open a file first.');
    return;
  }
  const doc = editor.document;
  const range = computeTargetRange(doc, editor.selection);
  const original = doc.getText(range);
  if (!original.trim()) {
    vscode.window.showInformationMessage('Sunday Inline Edit: nothing to rewrite (empty selection).');
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: 'Sunday Inline Edit',
    prompt: 'Describe the change (Esc to cancel)',
    placeHolder: 'e.g. convert this to async/await and add error handling',
  });
  if (instruction === undefined || !instruction.trim()) {
    if (instruction !== undefined) {
      vscode.window.showInformationMessage('Sunday Inline Edit: an instruction is required.');
    }
    return;
  }

  let rewritten: string;
  try {
    rewritten = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Sunday: rewriting selection…',
        cancellable: true,
      },
      async (progress, token) => {
        const bridge = await deps.ensureBridge();
        if (!bridge) throw new Error('Sunday sidecar is not running.');
        const reply = await requestRewrite(
          bridge,
          buildEditPrompt(instruction, original, doc.languageId),
          deps,
          token,
        );
        return extractRewrittenCode(reply);
      },
    );
  } catch (err) {
    const msg = (err as Error).message;
    deps.log(`inline edit failed: ${msg}`);
    vscode.window.showErrorMessage(`Sunday Inline Edit failed: ${msg}`);
    return;
  }

  if (!rewritten || rewritten === original) {
    vscode.window.showInformationMessage('Sunday Inline Edit: the agent proposed no changes.');
    return;
  }

  // Review surface: untitled temp doc + vscode.diff.
  const tempDoc = await vscode.workspace.openTextDocument({
    language: doc.languageId,
    content: rewritten,
  });
  await vscode.commands.executeCommand(
    'vscode.diff',
    doc.uri,
    tempDoc.uri,
    'Sunday Inline Edit — review',
  );

  const choice = await vscode.window.showInformationMessage(
    'Apply the rewritten code?',
    { modal: true },
    'Accept',
    'Reject',
  );
  const closeDiff = () =>
    vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  if (choice === 'Accept') {
    // User-confirmed edit (see POLICY DECISION above): the reviewed text is
    // written to the original editor over the original range.
    const ok = await applyReplacement(editor, range, rewritten);
    await closeDiff();
    deps.log(`inline edit: applied (${ok ? 'ok' : 'failed'})`);
    vscode.window.showInformationMessage(
      ok ? 'Sunday: edit applied.' : 'Sunday: edit could not be applied.',
    );
  } else {
    await closeDiff();
    deps.log('inline edit: rejected by user');
    vscode.window.showInformationMessage('Sunday: edit discarded.');
  }
}

/** Register the `sunday.inlineEdit` command. Called from extension.ts activate(). */
export function registerInlineEdit(
  context: vscode.ExtensionContext,
  deps: InlineEditDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, () => {
      void runInlineEdit(deps);
    }),
  );
}
