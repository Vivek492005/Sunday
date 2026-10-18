// sunday-agent — ChatViewProvider: hosts the @sunday/ui-chat webview.
//
// Serves the built ui-chat bundle (dist/index.html) inside a VS Code
// WebviewView, routes webview messages to the HostBridge/sundayd sidecar, and
// forwards daemon chat events back to the webview. vscode-coupled by design;
// the message/event mapping is covered by chatView.test.ts with a mocked
// `vscode` module.
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';
import type { ChatEventNotification, ChatEventRelay } from '@sunday/protocol';
import { composeChatMessage, type ImageAttachment } from './mentions.js';
import {
  buildVoiceConfigMessage,
  VOICE_UNSUPPORTED_MESSAGE,
} from './voice.js';
import { getEntitlementsView } from './entitlements/provider.js';
import { SUNDAY_MODELS } from './sundayModels.js';
import {
  gateModelList,
  isManagedModel,
  modelSelectionBlock,
  type GatedModel,
} from './entitlements/modelGating.js';
import {
  readUsedToday,
  recordManagedRequest,
  type MementoLike,
} from './entitlements/usage.js';
import {
  ContextCockpit,
  parseSlashCommand,
} from './context/index.js';

export const CHAT_VIEW_TYPE = 'sunday.chatView';

export interface ChatViewDeps {
  /** context.extensionPath of the sunday-agent extension. */
  extensionPath: string;
  /** Current bridge, if the sidecar is up. */
  getBridge: () => HostBridge | undefined;
  /** Start the sidecar if needed and return the bridge. */
  ensureBridge: () => Promise<HostBridge>;
  /** cwd for a fresh session (first workspace folder). */
  getCwd: () => string | undefined;
  /** Extension global state (local daily managed-model usage counter). */
  globalState: MementoLike;
  log: (msg: string) => void;
}

/**
 * Locate the built ui-chat bundle. Dev checkout first
 * (`<extensionDir>/../ui-chat/dist`), then the packaged layout
 * (`<extensionDir>/ui-chat/dist`). The first candidate containing
 * `index.html` wins; otherwise a clear, actionable error.
 */
export function resolveChatDistDir(extensionPath: string): string {
  const candidates = [
    path.join(extensionPath, '..', 'ui-chat', 'dist'),
    path.join(extensionPath, 'ui-chat', 'dist'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'index.html')).isFile()) return dir;
    } catch {
      /* not here — try the next candidate */
    }
  }
  throw new Error(
    'Sunday chat UI not found. Looked for index.html in:\n' +
      candidates.map((c) => `  - ${c}`).join('\n') +
      '\nBuild @sunday/ui-chat first: pnpm --filter @sunday/ui-chat build.',
  );
}

/** `via`/`relay` ride on chat/event notifications when the Phase-3 router
 *  fails over to another provider mid-turn. The webview badges the turn. */
function relayOf(n: ChatEventNotification): { via?: 'direct' | 'relay'; relay?: ChatEventRelay } {
  if (n.via !== 'relay' && n.via !== 'direct') return {};
  return n.relay ? { via: n.via, relay: n.relay } : { via: n.via };
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = CHAT_VIEW_TYPE;

  private view: vscode.WebviewView | undefined;
  private sessionId: string | undefined;
  private activeTurnId: string | undefined;
  private detachBridge: (() => void) | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * F4 Context Cockpit — one per chat session. Tracks local messages, pinned
   * facts, and compaction ledgers; intercepts /compact, /pin, /forget before
   * the text reaches the agent bridge.
   */
  private cockpit: ContextCockpit | undefined;
  /**
   * Last entitlement-gated model list sent to the webview. Used to validate
   * the model chosen in `sunday/chat/send` — selecting a greyed/excluded
   * model shows an info message instead of calling the model.
   */
  private gatedModels: GatedModel[] = [];

  constructor(private readonly deps: ChatViewDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.distDir())],
    };
    webview.html = this.renderHtml(webview);
    this.attachBridge();
    this.postVoiceConfig();
    webview.onDidReceiveMessage(
      (msg: unknown) => {
        void this.onMessage(msg);
      },
      undefined,
      this.disposables,
    );
    webviewView.onDidDispose(() => this.disposeView(), undefined, this.disposables);
  }

  /** Read sunday.voice.* config and push it to the webview. */
  private postVoiceConfig(): void {
    const cfg = vscode.workspace.getConfiguration('sunday');
    this.post(buildVoiceConfigMessage(cfg));
  }

  /** Re-subscribe when the bridge instance changes (sidecar restart/crash). */
  notifyBridgeChanged(): void {
    if (this.view) this.attachBridge();
  }

  /** Re-push sunday.voice.* config (e.g. after a settings change). */
  notifyVoiceConfigChanged(): void {
    if (this.view) this.postVoiceConfig();
  }

  dispose(): void {
    this.disposeView();
  }

  private distDir(): string {
    return resolveChatDistDir(this.deps.extensionPath);
  }

  private attachBridge(): void {
    this.detachBridge?.();
    this.detachBridge = undefined;
    const bridge = this.deps.getBridge();
    if (!bridge) return;
    this.detachBridge = bridge.onChatEvent((n) => this.forwardEvent(n));
  }

  private post(msg: unknown): void {
    if (this.view) {
      void this.view.webview.postMessage(msg);
    }
  }

  private forwardEvent(n: ChatEventNotification): void {
    this.post({
      type: 'sunday/chat/event',
      turnId: n.turnId,
      sessionId: n.sessionId,
      event: n.event,
      ...relayOf(n),
    });
    if (n.event.type === 'turn-end' || n.event.type === 'turn-error') {
      if (this.activeTurnId === n.turnId) this.activeTurnId = undefined;
      this.post({ type: 'sunday/chat/state', activeTurn: null });
    }
  }

  private async onMessage(msg: unknown): Promise<void> {
    const m = msg as { type?: unknown; text?: unknown; model?: unknown; images?: unknown };
    if (!m || typeof m.type !== 'string') return;
    try {
      switch (m.type) {
        case 'sunday/chat/send':
          await this.handleSend(
            typeof m.text === 'string' ? m.text : '',
            Array.isArray(m.images)
              ? (m.images as ImageAttachment[]).filter(
                  (i) => i && typeof i.dataUrl === 'string',
                )
              : [],
            typeof m.model === 'string' ? m.model : undefined,
          );
          break;
        case 'sunday/chat/cancel':
          await this.handleCancel();
          break;
        case 'sunday/models/get':
          await this.handleModelsGet();
          break;
        case 'sunday/voice/unsupported':
          // The chat webview's mic button is shown (with an explanatory
          // tooltip) even when the Web Speech API is missing; clicking it
          // reports here so the user gets a native info message instead of
          // a dead button or a crash.
          void vscode.window.showInformationMessage(VOICE_UNSUPPORTED_MESSAGE);
          break;
        default:
          this.deps.log(`chat view: ignoring unknown message type "${m.type}"`);
      }
    } catch (err) {
      this.deps.log(`chat view: "${m.type}" failed: ${(err as Error).message}`);
    }
  }

  /**
   * F4: intercept /compact, /pin, /forget. Returns true when the input was
   * a context command (handled locally — nothing is sent to the bridge).
   */
  private async handleContextSlash(text: string): Promise<boolean> {
    const cmd = parseSlashCommand(text);
    if (!cmd) return false;
    if (!this.cockpit) this.cockpit = new ContextCockpit();
    const cockpit = this.cockpit;
    // The command itself is part of the local history.
    cockpit.trackUserMessage(text);
    const replies: string[] = [];
    cockpit.handleSlash(cmd, (md) => replies.push(md));
    for (const md of replies) {
      cockpit.trackAssistantMessage(md);
      this.postLocalReply(md);
    }
    this.deps.log(`chat view: context slash "/${cmd.command}" handled locally`);
    return true;
  }

  /**
   * F4: render a local (non-model) reply in the chat webview by synthesizing
   * a completed turn: text-delta followed by turn-end. The webview creates
   * the assistant message from the delta, same as a real turn.
   */
  private postLocalReply(markdown: string): void {
    const turnId = `local-ctx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const sessionId = this.sessionId ?? 'local';
    this.post({
      type: 'sunday/chat/event',
      turnId,
      sessionId,
      event: { type: 'text-delta', delta: markdown },
    });
    this.post({
      type: 'sunday/chat/event',
      turnId,
      sessionId,
      event: { type: 'turn-end', finishReason: 'stop' },
    });
  }

  private async handleSend(text: string, images: ImageAttachment[], model?: string): Promise<void> {
    const t = text.trim();
    if (!t && images.length === 0) return;
    // F4 Context Cockpit: /compact, /pin, /forget never reach the model —
    // they are handled locally and answered in the chat UI.
    if (await this.handleContextSlash(t)) return;
    // Task 7 gate: a plan-gated model selection never reaches the model —
    // show the upgrade/info message instead. Fail open when the list was
    // never fetched (empty gated list).
    const block = modelSelectionBlock(this.gatedModels, model);
    if (block) {
      vscode.window.showInformationMessage(`Sunday: ${block}`);
      this.deps.log(`chat view: blocked send with gated model "${model}"`);
      return;
    }
    // Phase 3: never fail silently. If the bridge/sidecar is unreachable,
    // tell the user in plain language instead of swallowing the message.
    let bridge: HostBridge;
    try {
      bridge = await this.deps.ensureBridge();
    } catch (err) {
      const msg = (err as Error).message;
      this.deps.log(`chat view: ensureBridge failed: ${msg}`);
      this.post({ type: 'sunday/chat/state', activeTurn: null });
      void vscode.window.showErrorMessage(
        'Sunday agent se connect nahi ho paya. Apna internet check karo aur dobara try karo.',
        'Retry',
      ).then((action) => {
        if (action === 'Retry') void this.handleSend(text, images, model);
      });
      return;
    }
    if (!this.sessionId) {
      try {
        this.sessionId = await this.getOrCreateSession(bridge);
      } catch (err) {
        const msg = (err as Error).message;
        this.deps.log(`chat view: session create failed: ${msg}`);
        this.post({ type: 'sunday/chat/state', activeTurn: null });
        void vscode.window.showErrorMessage(
          'Sunday chat session start nahi ho paya. Dobara try karo.',
          'Retry',
        ).then((action) => {
          if (action === 'Retry') void this.handleSend(text, images, model);
        });
        return;
      }
    }
    // Part B (worker 4): expand @-mentions into context parts and attach
    // pasted images. `chat/send` already accepts a ContentPart[] message.
    const message = await composeChatMessage(t, images, {
      workspaceRoot: this.deps.getCwd(),
    });
    try {
      const { turnId } = await bridge.chatSend({ sessionId: this.sessionId, message, model });
      this.activeTurnId = turnId;
      this.post({ type: 'sunday/chat/state', activeTurn: turnId });
    } catch (err) {
      const msg = (err as Error).message;
      this.deps.log(`chat view: chatSend failed: ${msg}`);
      this.post({ type: 'sunday/chat/state', activeTurn: null });
      // Session may have expired server-side — clear it so the next send
      // creates a fresh one instead of retrying a dead session forever.
      this.sessionId = undefined;
      void vscode.window.showErrorMessage(
        `Sunday se jawab nahi mil paya: ${msg}`,
        'Retry',
      ).then((action) => {
        if (action === 'Retry') void this.handleSend(text, images, model);
      });
      return;
    }
    // Track managed-model usage for the daily-limit grey-out in the model
    // picker. Local approximation only — the gateway enforces the real
    // quota server-side. Never let counter failures break the send path.
    if (model && this.gatedModels.some((m) => m.id === model && isManagedModel(m))) {
      try {
        await recordManagedRequest(this.deps.globalState);
      } catch (err) {
        this.deps.log(`chat view: usage counter failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Phase 3: session persistence. The session id is cached per workspace
   * folder so a webview reload (or extension host restart) restores the
   * existing daemon session instead of orphaning it and starting fresh.
   * Falls back to creating a new session when restore fails.
   */
  private async getOrCreateSession(bridge: HostBridge): Promise<string> {
    const cwd = this.deps.getCwd();
    const key = `sunday.chatSession.${cwd ?? 'default'}`;
    const state = (this.deps.globalState as unknown as {
      get<T>(k: string): T | undefined;
      update(k: string, v: unknown): Thenable<void>;
    });
    const cached = state.get<string>(key);
    if (cached) {
      try {
        await bridge.sessionRestore(cached);
        this.deps.log(`chat view: restored session ${cached}`);
        return cached;
      } catch (err) {
        this.deps.log(`chat view: session restore failed (${(err as Error).message}), creating new`);
      }
    }
    const { session } = await bridge.sessionCreate({ cwd });
    this.deps.log(`chat view: created session ${session.id}`);
    try {
      await state.update(key, session.id);
    } catch (err) {
      this.deps.log(`chat view: session persist failed: ${(err as Error).message}`);
    }
    return session.id;
  }

  private async handleCancel(): Promise<void> {
    const bridge = this.deps.getBridge();
    if (!bridge) return;
    const cancelled = await bridge.cancelActiveTurn().catch((err: Error) => {
      this.deps.log(`chat view: cancel failed: ${err.message}`);
      return false;
    });
    if (cancelled) {
      this.activeTurnId = undefined;
      this.post({ type: 'sunday/chat/state', activeTurn: null });
    }
  }

  private async handleModelsGet(): Promise<void> {
    // Fallback models so the picker is never empty (user 2026-10-11:
    // "models agent window mai load nahi ho rahe"). Used when the bridge
    // is unreachable; the gateway remains the source of truth otherwise.
    // Phase 3: canonical list from sundayModels.ts (single source of truth).
    const FALLBACK_MODELS = SUNDAY_MODELS.map((m) => ({
      id: m.id,
      provider: m.provider,
      label: m.label,
    }));
    let models: Array<{ id: string; provider: string; label: string }>;
    try {
      const bridge = await this.deps.ensureBridge();
      ({ models } = await bridge.modelsList());
      if (!models || models.length === 0) models = FALLBACK_MODELS;
    } catch (err) {
      this.deps.log(`chat view: modelsList failed, using fallback: ${(err as Error).message}`);
      models = FALLBACK_MODELS;
    }
    // Task 7 gate: exclude managed models the plan doesn't include, or grey
    // them out when the local daily counter says the quota is spent. Fail
    // open on any entitlement problem — the gateway enforces server-side.
    let gated: GatedModel[];
    try {
      const view = await getEntitlementsView(this.deps.log);
      gated = gateModelList(models, view, readUsedToday(this.deps.globalState));
    } catch (err) {
      this.deps.log(`chat view: model gating failed, failing open: ${(err as Error).message}`);
      gated = models.map((m) => ({ ...m }));
    }
    this.gatedModels = gated;
    this.post({
      type: 'sunday/models/list',
      models: gated.map(({ id, provider, label, disabled, hint }) => ({
        id,
        provider,
        label,
        ...(disabled ? { disabled, hint } : {}),
      })),
    });
  }

  /**
   * Build the webview HTML: rewrite the vite bundle's relative asset URLs to
   * webview URIs, nonce every script, and install a strict CSP.
   */
  private renderHtml(webview: vscode.Webview): string {
    const distDir = this.distDir();
    const distUri = webview.asWebviewUri(vscode.Uri.file(distDir));
    const nonce = crypto.randomBytes(16).toString('hex');
    let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    html = html.replace(/(src|href)="\.\//g, `$1="${distUri}/`);
    html = html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
    const csp =
      `<meta http-equiv="Content-Security-Policy" ` +
      `content="default-src 'none'; script-src 'nonce-${nonce}'; ` +
      `style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">`;
    html = html.includes('<head>') ? html.replace('<head>', `<head>\n${csp}`) : `${csp}\n${html}`;
    return html;
  }

  private disposeView(): void {
    this.detachBridge?.();
    this.detachBridge = undefined;
    this.view = undefined;
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}
