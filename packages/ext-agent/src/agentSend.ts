// sunday-agent — AgentSender: shared "send a message to the agent" helper for
// the Part B editor-intelligence features (code actions, commit message,
// terminal error explanation).
//
// DESIGN DECISION (documented for the brief): every feature here sends via
// direct `chatSend` and then focuses the chat view (`sunday.chat.focus`).
// We do NOT open the chat view with the prompt pre-filled, because
// ChatViewProvider exposes no prefill path (it only accepts
// `sunday/chat/send` messages from its own webview). Direct send works
// because the webview forwards `chat/event` notifications for any session
// without filtering, so the turn streams visibly once the view is focused.
//
// Sessions: one cached session per AgentSender (cwd = first workspace
// folder). `sendAndCollect` additionally subscribes to `chat/event` BEFORE
// the turnId is known and accumulates `text-delta`s until `turn-end` —
// needed by the commit-message command, which needs the model's text back.
import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';
import type { ChatEventNotification, ContentPart } from '@sunday/protocol';
import {
  estimateTask,
  formatEstimate,
  type TaskEstimate,
  type BudgetScope,
} from './budgets/index.js';

export interface AgentSendDeps {
  /** Start the sidecar if needed and return the bridge. */
  ensureBridge: () => Promise<HostBridge>;
  /** cwd for a fresh session (first workspace folder). */
  getCwd: () => string | undefined;
  log: (msg: string) => void;
  /** F1: rolling average requests/task for the estimator (optional). */
  getPastAvgRequests?: () => number | undefined;
  /** F1: notified with the pre-run estimate before each send (optional). */
  onEstimate?: (estimate: TaskEstimate, message: string) => void;
  /**
   * F1: hard-budget gate — return the paused scopes (empty = clear to send).
   * When non-empty, send() throws with a "continue +N" hint instead of
   * sending.
   */
  getPausedScopes?: () => BudgetScope[];
}

export interface CollectedTurn {
  ok: boolean;
  /** Full assistant text when ok. */
  text?: string;
  /** Failure reason when !ok. */
  error?: string;
}

/** Default budget for a collect-style turn (commit message, etc.). */
export const COLLECT_TIMEOUT_MS = 120_000;

export class AgentSender {
  private sessionId: string | undefined;

  constructor(private readonly deps: AgentSendDeps) {}

  private async session(bridge: HostBridge): Promise<string> {
    if (!this.sessionId) {
      const { session } = await bridge.sessionCreate({ cwd: this.deps.getCwd() });
      this.sessionId = session.id;
      this.deps.log(`agentSend: created session ${session.id}`);
    }
    return this.sessionId;
  }

  /**
   * F1: pre-run estimate + hard-budget gate. Computes the estimate (logged
   * and forwarded via onEstimate), then refuses to send when a hard budget
   * is paused — the user resumes with `sunday.budget.continue`.
   */
  private preSend(message: string, model?: string): TaskEstimate {
    const estimate = estimateTask(message, {
      modelId: model,
      pastAvgRequests: this.deps.getPastAvgRequests?.(),
    });
    this.deps.log(`agentSend: pre-run estimate ${formatEstimate(estimate)} (${estimate.rationale})`);
    try {
      this.deps.onEstimate?.(estimate, message);
    } catch {
      /* observer is best-effort */
    }
    const paused = this.deps.getPausedScopes?.() ?? [];
    if (paused.length > 0) {
      throw new Error(
        `Sunday budget paused (${paused.join(', ')}). ` +
          `Run "Sunday: Continue Budget" to add more requests, or raise the limit in "Sunday: Budget Settings".`,
      );
    }
    return estimate;
  }

  /**
   * Send a message and return the turnId once the daemon accepts it. Focuses
   * the Sunday chat view so the user watches the turn stream.
   */
  async send(message: string, model?: string): Promise<string> {
    this.preSend(message, model);
    const bridge = await this.deps.ensureBridge();
    const sessionId = await this.session(bridge);
    const { turnId } = await bridge.chatSend({ sessionId, message, model });
    await vscode.commands.executeCommand('sunday.chat.focus');
    return turnId;
  }

  /**
   * Send a message and collect the turn's full text, resolving on `turn-end`
   * (or `turn-error` / timeout). The event subscription is attached before
   * `chatSend` so no early `text-delta` is missed. Accepts content parts so
   * callers can attach images (design-to-code).
   */
  async sendAndCollect(
    message: string | ContentPart[],
    model: string | undefined,
    timeoutMs = COLLECT_TIMEOUT_MS,
  ): Promise<CollectedTurn> {
    this.preSend(typeof message === 'string' ? message : '[multimodal message]', model);
    const bridge = await this.deps.ensureBridge();
    const sessionId = await this.session(bridge);

    const chunks: string[] = [];
    let turnId: string | undefined;
    let settled = false;
    let finish: (r: CollectedTurn) => void = () => undefined;
    const done = new Promise<CollectedTurn>((resolve) => {
      finish = resolve;
    });
    const settle = (r: CollectedTurn): void => {
      if (settled) return;
      settled = true;
      unsub();
      finish(r);
    };

    const unsub = bridge.onChatEvent((n: ChatEventNotification) => {
      if (!turnId || n.turnId !== turnId) return;
      const e = n.event;
      if (e.type === 'text-delta') chunks.push(e.delta);
      else if (e.type === 'turn-end')
        settle(
          e.finishReason === 'stop'
            ? { ok: true, text: chunks.join('') }
            : { ok: false, error: `turn finished: ${e.finishReason}` },
        );
      else if (e.type === 'turn-error') settle({ ok: false, error: e.message });
    });

    const timer = setTimeout(() => settle({ ok: false, error: 'timed out waiting for the turn' }), timeoutMs);
    // Don't let the timer keep the extension host alive on its own.
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }

    try {
      const res = await bridge.chatSend({ sessionId, message, model });
      turnId = res.turnId;
      return await done;
    } catch (err) {
      settle({ ok: false, error: (err as Error).message });
      return done;
    } finally {
      clearTimeout(timer);
    }
  }
}
