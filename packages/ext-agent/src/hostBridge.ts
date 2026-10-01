// sunday-agent — HostBridge: the typed facade over the sundayd JSON-RPC
// connection. Owns request/response correlation (via RpcClient), chat/event
// notification dispatch, per-method timeouts, and active-turn tracking for
// the "Stop" command. vscode-free; tested against a fixture daemon.

import {
  METHODS,
  chatEventNotificationSchema,
  type ChatEventNotification,
  type MethodName,
  type MethodParams,
  type MethodResult,
} from '@sunday/protocol';
import { RpcClient } from './rpc.js';

/**
 * Typed JSON-RPC facade. Every result is validated against the protocol
 * registry — a daemon that answers with a wrong shape fails loudly here,
 * not deep in the UI.
 */
export class HostBridge {
  private readonly disposeChatEvent: () => void;
  private readonly chatListeners = new Set<(n: ChatEventNotification) => void>();
  private activeTurnId: string | undefined;

  constructor(
    private readonly rpc: RpcClient,
    private readonly defaultTimeoutMs = 30000,
  ) {
    this.disposeChatEvent = rpc.onNotification('chat/event', (params) => this.dispatchChatEvent(params));
  }

  private async call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    timeoutMs?: number,
  ): Promise<MethodResult<M>> {
    const raw = await this.rpc.request(method, params, { timeoutMs: timeoutMs ?? this.defaultTimeoutMs });
    return METHODS[method].result.parse(raw) as MethodResult<M>;
  }

  // -- handshake / lifecycle -------------------------------------------------

  ping(): Promise<MethodResult<'sunday/ping'>> {
    return this.call('sunday/ping', {}, 10000);
  }

  // -- sessions ---------------------------------------------------------------

  sessionCreate(params: MethodParams<'session/create'>): Promise<MethodResult<'session/create'>> {
    return this.call('session/create', params);
  }

  sessionList(): Promise<MethodResult<'session/list'>> {
    return this.call('session/list', {});
  }

  sessionRestore(sessionId: string): Promise<MethodResult<'session/restore'>> {
    return this.call('session/restore', { sessionId });
  }

  sessionClose(sessionId: string): Promise<MethodResult<'session/close'>> {
    if (this.activeTurnId) {
      // Best effort: don't strand a turn in a closing session.
      void this.chatCancel(this.activeTurnId).catch(() => undefined);
      this.activeTurnId = undefined;
    }
    return this.call('session/close', { sessionId });
  }

  // -- chat -------------------------------------------------------------------

  /**
   * Start a turn. Resolves with the turnId as soon as the daemon accepts it;
   * progress streams through onChatEvent until turn-end/turn-error.
   */
  async chatSend(params: MethodParams<'chat/send'>): Promise<MethodResult<'chat/send'>> {
    const res = await this.call('chat/send', params);
    this.activeTurnId = res.turnId;
    return res;
  }

  chatCancel(turnId: string): Promise<MethodResult<'chat/cancel'>> {
    if (this.activeTurnId === turnId) this.activeTurnId = undefined;
    return this.call('chat/cancel', { turnId }, 10000);
  }

  /** Cancel the tracked turn, if any. Returns false when there is none. */
  async cancelActiveTurn(): Promise<boolean> {
    const turnId = this.activeTurnId;
    if (!turnId) return false;
    await this.chatCancel(turnId);
    return true;
  }

  getActiveTurnId(): string | undefined {
    return this.activeTurnId;
  }

  /** Subscribe to `chat/event` notifications. Returns an unsubscribe fn. */
  onChatEvent(listener: (n: ChatEventNotification) => void): () => void {
    this.chatListeners.add(listener);
    return () => {
      this.chatListeners.delete(listener);
    };
  }

  // -- catalogue ----------------------------------------------------------------

  toolsList(): Promise<MethodResult<'tools/list'>> {
    return this.call('tools/list', {});
  }

  modelsList(): Promise<MethodResult<'models/list'>> {
    // Model listing can hit the network (provider APIs) — allow longer.
    return this.call('models/list', {}, 60000);
  }

  dispose(): void {
    this.disposeChatEvent();
    this.chatListeners.clear();
    this.activeTurnId = undefined;
  }

  private dispatchChatEvent(params: unknown): void {
    const parsed = chatEventNotificationSchema.safeParse(params);
    if (!parsed.success) return; // malformed daemon event — drop, don't crash UI
    const n: ChatEventNotification = parsed.data;
    if ((n.event.type === 'turn-end' || n.event.type === 'turn-error') && n.turnId === this.activeTurnId) {
      this.activeTurnId = undefined;
    }
    for (const l of [...this.chatListeners]) {
      try {
        l(n);
      } catch {
        /* one bad listener must not break dispatch */
      }
    }
  }
}
