// Framework-free chat state for the ui-chat webview.
//
// All message/event application logic lives here (no React, no DOM) so it is
// unit-testable with plain vitest. The React layer (App.tsx) is a thin shell
// over `createInitialState` + the `apply*` functions below.
import type { ImageWire } from './images.js';

// -- wire types (mirror the extension↔webview protocol; JSON only) ----------

export type Via = 'direct' | 'relay';

export interface RelayInfo {
  from: string;
  to: string;
  reason: string;
}

export interface ToolCallWire {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResultWire {
  id: string;
  ok: boolean;
  summary?: string;
}

export type ChatEventWire =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; call: ToolCallWire }
  | { type: 'tool-result'; result: ToolResultWire }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; costUsd?: number } }
  | { type: 'turn-end'; finishReason: 'stop' | 'cancelled' | 'error' | 'max-steps' }
  | { type: 'turn-error'; code: number; message: string };

export interface ChatEventNotificationWire {
  turnId: string;
  sessionId: string;
  event: ChatEventWire;
  via?: Via;
  relay?: RelayInfo;
}

export interface ModelView {
  id: string;
  provider: string;
  label: string;
  /**
   * Task 7: plan-gated model — listed but not selectable (e.g. the daily
   * managed-model quota is spent). Rendered greyed with `hint`.
   */
  disabled?: boolean;
  /** Human-readable reason for `disabled` (e.g. "Daily limit reached — upgrade"). */
  hint?: string;
}

/** Extension → webview. */
export type InboundMessage =
  | ({ type: 'sunday/chat/event' } & ChatEventNotificationWire)
  | { type: 'sunday/models/list'; models: ModelView[] }
  | { type: 'sunday/chat/state'; activeTurn: string | null }
  | { type: 'sunday/voice/config'; inputEnabled: boolean; outputEnabled: boolean; language: string };

/** Webview → extension. */
export type OutboundMessage =
  | {
      type: 'sunday/chat/send';
      text: string;
      model?: string;
      /** Pasted image attachments (data: URLs), carried to `chat/send` as
       *  image content parts. */
      images?: ImageWire[];
    }
  | { type: 'sunday/chat/cancel' }
  | { type: 'sunday/models/get' }
  /** Sent when the user clicks the mic button while the Web Speech API is
   *  missing — the extension host answers with a native info message. */
  | { type: 'sunday/voice/unsupported' };

// -- view state ---------------------------------------------------------------

export interface ToolCallView {
  id: string;
  name: string;
  argsSummary: string;
  status: 'running' | 'done';
  resultSummary?: string;
}

export interface ChatMessageView {
  id: string;
  turnId?: string;
  role: 'user' | 'assistant';
  /** Markdown source (assistant) or plain text (user). */
  text: string;
  status: 'streaming' | 'done' | 'error';
  toolCalls: ToolCallView[];
  via?: Via;
  relay?: RelayInfo;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface ChatState {
  messages: ChatMessageView[];
  activeTurnId: string | undefined;
  models: ModelView[];
  selectedModel: string | undefined;
  /** Connection-level banner (sidecar down, send failed…). */
  error: string | undefined;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export function createInitialState(): ChatState {
  return { messages: [], activeTurnId: undefined, models: [], selectedModel: undefined, error: undefined };
}

/** Optimistically append the user's message the moment Send is hit. */
export function queueUserMessage(state: ChatState, text: string): ChatState {
  const msg: ChatMessageView = {
    id: nextId('msg'),
    role: 'user',
    text,
    status: 'done',
    toolCalls: [],
  };
  return { ...state, messages: [...state.messages, msg], error: undefined };
}

function summarizeArgs(args: unknown): string {
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  } catch {
    return '';
  }
}

function replaceMessage(
  messages: ChatMessageView[],
  id: string,
  next: ChatMessageView,
): ChatMessageView[] {
  return messages.map((m) => (m.id === id ? next : m));
}

/** Find the streaming assistant message for this turn, or start a new one. */
function ensureAssistantMessage(
  state: ChatState,
  notif: ChatEventNotificationWire,
): { messages: ChatMessageView[]; msg: ChatMessageView } {
  const existing = state.messages.find((m) => m.turnId === notif.turnId && m.role === 'assistant');
  if (existing) return { messages: state.messages, msg: existing };
  const msg: ChatMessageView = {
    id: nextId('msg'),
    turnId: notif.turnId,
    role: 'assistant',
    text: '',
    status: 'streaming',
    toolCalls: [],
  };
  return { messages: [...state.messages, msg], msg };
}

function relayPatch(
  msg: ChatMessageView,
  notif: ChatEventNotificationWire,
): Partial<ChatMessageView> {
  // Stick the relay badge on the turn the moment we first see via=relay.
  if (notif.via && !msg.via) return { via: notif.via, relay: notif.relay };
  return {};
}

/** Apply one daemon chat event to the state. Pure — returns a new state. */
export function applyEvent(state: ChatState, notif: ChatEventNotificationWire): ChatState {
  const ev = notif.event;
  switch (ev.type) {
    case 'text-delta': {
      const { messages, msg } = ensureAssistantMessage(state, notif);
      const next: ChatMessageView = {
        ...msg,
        text: msg.text + ev.delta,
        status: 'streaming',
        ...relayPatch(msg, notif),
      };
      return { ...state, activeTurnId: notif.turnId, messages: replaceMessage(messages, msg.id, next) };
    }
    case 'tool-call': {
      const { messages, msg } = ensureAssistantMessage(state, notif);
      const tc: ToolCallView = {
        id: ev.call.id,
        name: ev.call.name,
        argsSummary: summarizeArgs(ev.call.arguments),
        status: 'running',
      };
      const next: ChatMessageView = {
        ...msg,
        status: 'streaming',
        toolCalls: [...msg.toolCalls, tc],
        ...relayPatch(msg, notif),
      };
      return { ...state, activeTurnId: notif.turnId, messages: replaceMessage(messages, msg.id, next) };
    }
    case 'tool-result': {
      const { messages, msg } = ensureAssistantMessage(state, notif);
      const toolCalls = msg.toolCalls.map((tc) =>
        tc.id === ev.result.id
          ? { ...tc, status: 'done' as const, resultSummary: ev.result.summary ?? (ev.result.ok ? 'ok' : 'failed') }
          : tc,
      );
      const next: ChatMessageView = { ...msg, toolCalls, ...relayPatch(msg, notif) };
      return { ...state, activeTurnId: notif.turnId, messages: replaceMessage(messages, msg.id, next) };
    }
    case 'usage': {
      const { messages, msg } = ensureAssistantMessage(state, notif);
      const next: ChatMessageView = {
        ...msg,
        usage: { inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens },
        ...relayPatch(msg, notif),
      };
      return { ...state, activeTurnId: notif.turnId, messages: replaceMessage(messages, msg.id, next) };
    }
    case 'turn-end': {
      const { messages, msg } = ensureAssistantMessage(state, notif);
      const next: ChatMessageView = { ...msg, status: 'done', ...relayPatch(msg, notif) };
      return {
        ...state,
        activeTurnId: state.activeTurnId === notif.turnId ? undefined : state.activeTurnId,
        messages: replaceMessage(messages, msg.id, next),
      };
    }
    case 'turn-error': {
      const { messages, msg } = ensureAssistantMessage(state, notif);
      const next: ChatMessageView = {
        ...msg,
        status: 'error',
        error: ev.message || `Turn failed (code ${ev.code})`,
        ...relayPatch(msg, notif),
      };
      return {
        ...state,
        activeTurnId: state.activeTurnId === notif.turnId ? undefined : state.activeTurnId,
        messages: replaceMessage(messages, msg.id, next),
      };
    }
  }
}

export function applyModelsList(state: ChatState, models: ModelView[]): ChatState {
  // Task 7: a plan-gated (disabled) model is never auto-selected — prefer
  // the first selectable model, falling back to the raw first entry only
  // when every model is gated.
  const current = models.find((m) => m.id === state.selectedModel);
  const stillValid = current !== undefined && !current.disabled;
  return {
    ...state,
    models,
    selectedModel: stillValid
      ? state.selectedModel
      : (models.find((m) => !m.disabled)?.id ?? models[0]?.id),
  };
}

export function selectModel(state: ChatState, modelId: string): ChatState {
  const target = state.models.find((m) => m.id === modelId);
  // Unknown or plan-gated ids are ignored — the picker can't select them.
  if (!target || target.disabled) return state;
  return { ...state, selectedModel: modelId };
}

export function applyTurnState(state: ChatState, activeTurn: string | null): ChatState {
  return { ...state, activeTurnId: activeTurn ?? undefined };
}

export function setConnectionError(state: ChatState, error: string | undefined): ChatState {
  return { ...state, error };
}
