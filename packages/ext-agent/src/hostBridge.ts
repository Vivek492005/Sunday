// sunday-agent — HostBridge: the typed facade over the sundayd JSON-RPC
// connection. Owns request/response correlation (via RpcClient), chat/event
// notification dispatch, per-method timeouts, and active-turn tracking for
// the "Stop" command. vscode-free; tested against a fixture daemon.

import {
  METHODS,
  chatEventNotificationSchema,
  orchestrationEventSchema,
  type ChatEventNotification,
  type ConflictResolution,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type OrchestrationEvent,
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
  private readonly disposeOrchestrateEvent: () => void;
  private readonly orchestrateListeners = new Set<(n: OrchestrationEvent) => void>();
  private activeTurnId: string | undefined;

  constructor(
    private readonly rpc: RpcClient,
    private readonly defaultTimeoutMs = 30000,
  ) {
    this.disposeChatEvent = rpc.onNotification('chat/event', (params) => this.dispatchChatEvent(params));
    this.disposeOrchestrateEvent = rpc.onNotification('orchestrate/event', (params) =>
      this.dispatchOrchestrateEvent(params),
    );
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

  // -- inline completion (Part B) ---------------------------------------------

  /**
   * Ghost-text completion for a cursor position. The daemon debounces and
   * caches per document; a superseded keystroke resolves `cancelled: true`.
   * Short timeout — this backs interactive typing, not agent turns.
   */
  completionComplete(
    params: MethodParams<'completion/complete'>,
  ): Promise<MethodResult<'completion/complete'>> {
    return this.call('completion/complete', params, 15000);
  }

  completionStats(): Promise<MethodResult<'completion/stats'>> {
    return this.call('completion/stats', {}, 10000);
  }

  // -- manager (Phase 4: checkpoints + worktrees) --------------------------------

  checkpointCreate(
    params: MethodParams<'checkpoint/create'>,
  ): Promise<MethodResult<'checkpoint/create'>> {
    return this.call('checkpoint/create', params);
  }

  checkpointList(
    params: MethodParams<'checkpoint/list'>,
  ): Promise<MethodResult<'checkpoint/list'>> {
    return this.call('checkpoint/list', params);
  }

  checkpointRestore(
    params: MethodParams<'checkpoint/restore'>,
  ): Promise<MethodResult<'checkpoint/restore'>> {
    return this.call('checkpoint/restore', params);
  }

  worktreeAdd(params: MethodParams<'worktree/add'>): Promise<MethodResult<'worktree/add'>> {
    return this.call('worktree/add', params);
  }

  worktreeList(params: MethodParams<'worktree/list'>): Promise<MethodResult<'worktree/list'>> {
    return this.call('worktree/list', params);
  }

  worktreeRemove(
    params: MethodParams<'worktree/remove'>,
  ): Promise<MethodResult<'worktree/remove'>> {
    return this.call('worktree/remove', params);
  }

  worktreeMerge(params: MethodParams<'worktree/merge'>): Promise<MethodResult<'worktree/merge'>> {
    return this.call('worktree/merge', params);
  }

  // -- MCP (Part A: servers, tools, call history) --------------------------------

  mcpServersList(): Promise<MethodResult<'mcp/servers/list'>> {
    return this.call('mcp/servers/list', {});
  }

  mcpServerStart(name: string): Promise<MethodResult<'mcp/server/start'>> {
    return this.call('mcp/server/start', { name }, 60000);
  }

  mcpServerStop(name: string): Promise<MethodResult<'mcp/server/stop'>> {
    return this.call('mcp/server/stop', { name }, 30000);
  }

  mcpServerRestart(name: string): Promise<MethodResult<'mcp/server/restart'>> {
    return this.call('mcp/server/restart', { name }, 60000);
  }

  mcpToolsList(server?: string): Promise<MethodResult<'mcp/tools/list'>> {
    return this.call('mcp/tools/list', server ? { server } : {});
  }

  mcpCallsHistory(limit?: number): Promise<MethodResult<'mcp/calls/history'>> {
    return this.call('mcp/calls/history', limit === undefined ? {} : { limit });
  }

  // -- policy approvals (Part A: risk class M) -----------------------------------

  policyApprove(tool: string): Promise<MethodResult<'policy/approve'>> {
    return this.call('policy/approve', { tool });
  }

  policyRevoke(tool: string): Promise<MethodResult<'policy/revoke'>> {
    return this.call('policy/revoke', { tool });
  }

  policyList(): Promise<MethodResult<'policy/list'>> {
    return this.call('policy/list', {});
  }

  // -- orchestration (parallel agents) -------------------------------------------

  /**
   * Start an orchestration run. Keeps the Phase-5 blocking contract (resolves
   * with the final run result), but with a generous timeout — a full run can
   * take many minutes. Progress streams through onOrchestrateEvent.
   */
  orchestrateRun(
    params: MethodParams<'orchestrate/run'>,
  ): Promise<MethodResult<'orchestrate/run'>> {
    return this.call('orchestrate/run', params, 30 * 60 * 1000);
  }

  orchestrateStop(runId: string): Promise<MethodResult<'orchestrate/stop'>> {
    return this.call('orchestrate/stop', { runId }, 15000);
  }

  orchestrateStatus(runId: string): Promise<MethodResult<'orchestrate/status'>> {
    return this.call('orchestrate/status', { runId }, 15000);
  }

  orchestrateMerge(runId: string): Promise<MethodResult<'orchestrate/merge'>> {
    return this.call('orchestrate/merge', { runId }, 60000);
  }

  orchestrateResolveConflict(
    runId: string,
    resolutions: ConflictResolution[],
  ): Promise<MethodResult<'orchestrate/resolveConflict'>> {
    return this.call('orchestrate/resolveConflict', { runId, resolutions }, 60000);
  }

  /** Subscribe to `orchestrate/event` notifications. Returns an unsubscribe fn. */
  onOrchestrateEvent(listener: (n: OrchestrationEvent) => void): () => void {
    this.orchestrateListeners.add(listener);
    return () => {
      this.orchestrateListeners.delete(listener);
    };
  }

  // -- browser panel ------------------------------------------------------------

  /** Ensure browserd is running for the Agent Browser panel (no-op if up). */
  browserPanelEnsure(): Promise<MethodResult<'browser/panel/ensure'>> {
    return this.call('browser/panel/ensure', {}, 15000);
  }

  /** Open a URL in the agent browser. */
  browserPanelOpen(url: string): Promise<MethodResult<'browser/panel/open'>> {
    return this.call('browser/panel/open', { url }, 30000);
  }

  /** Latest screencast frame (base64 JPEG) for the live panel image. */
  browserPanelFrame(): Promise<MethodResult<'browser/panel/frame'>> {
    return this.call('browser/panel/frame', {}, 10000);
  }

  /** Hand browser control to the user (agent action tools fail fast meanwhile). */
  browserPanelTakeover(): Promise<MethodResult<'browser/panel/takeover'>> {
    return this.call('browser/panel/takeover', {}, 15000);
  }

  /** Hand browser control back to the agent. */
  browserPanelRelease(): Promise<MethodResult<'browser/panel/release'>> {
    return this.call('browser/panel/release', {}, 15000);
  }

  /** Current browser control holder ('agent' | 'user'). */
  browserPanelControl(): Promise<MethodResult<'browser/panel/control'>> {
    return this.call('browser/panel/control', {}, 10000);
  }

  /** One-shot screenshot (base64 PNG) for display in the panel. */
  browserPanelScreenshot(): Promise<MethodResult<'browser/panel/screenshot'>> {
    return this.call('browser/panel/screenshot', {}, 30000);
  }

  /** Stop the screencast and close the browser session. */
  browserPanelClose(): Promise<MethodResult<'browser/panel/close'>> {
    return this.call('browser/panel/close', {}, 15000);
  }

  dispose(): void {
    this.disposeChatEvent();
    this.chatListeners.clear();
    this.disposeOrchestrateEvent();
    this.orchestrateListeners.clear();
    this.activeTurnId = undefined;
  }

  private dispatchOrchestrateEvent(params: unknown): void {
    const parsed = orchestrationEventSchema.safeParse(params);
    if (!parsed.success) return; // malformed daemon event — drop, don't crash UI
    for (const l of [...this.orchestrateListeners]) {
      try {
        l(parsed.data);
      } catch {
        /* one bad listener must not break dispatch */
      }
    }
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
