/**
 * Typed access to the Sunday agent bridge (`window.sunday.agent`).
 *
 * NOTE: the main-process implementation is currently a STUB with mock
 * responses (see electron/main.ts `sunday:agent:*` handlers).
 * TODO(Wave 3): wire to the real Sunday agent loop in `packages/ext-agent`
 * (gateway chat, F1 estimator, usage ledger, budget enforcement).
 * The contracts below are final — only the main-process side changes.
 */
import type {
  SundayAPI,
  AgentMode,
  AgentMessage,
  AgentRequest,
  AgentReply,
  AgentEstimate,
  AgentUsage,
} from '../../electron/preload';

declare global {
  interface Window {
    sunday?: SundayAPI;
  }
}

function bridge(): SundayAPI {
  const api = window.sunday;
  if (!api) {
    throw new Error(
      'Sunday bridge unavailable — the Sunday IDE renderer must run inside the Electron shell (`pnpm dev`).',
    );
  }
  return api;
}

export const AGENT_MODES: { id: AgentMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Sunday picks the best approach' },
  { id: 'architect', label: 'Architect', hint: 'Plans before acting' },
  { id: 'implementer', label: 'Implementer', hint: 'Writes and edits code' },
  { id: 'reviewer', label: 'Reviewer', hint: 'Reviews code critically' },
];

export const AGENT_MODELS: { id: string; label: string }[] = [
  { id: 'auto', label: 'Auto (recommended)' },
  { id: 'llama-3.3-70b', label: 'Llama 3.3 70B' },
  { id: 'qwen-2.5-coder-32b', label: 'Qwen 2.5 Coder 32B' },
  { id: 'llama-3.1-8b', label: 'Llama 3.1 8B (fast)' },
];

const HISTORY_KEY = 'sunday.agent.history.v1';

export function loadHistory(): AgentMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AgentMessage[];
      if (Array.isArray(parsed)) return parsed.slice(-100);
    }
  } catch {
    // corrupted storage — start fresh
  }
  return [];
}

export function saveHistory(messages: AgentMessage[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-100)));
  } catch {
    // storage full/blocked — non-fatal
  }
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // non-fatal
  }
}

export const agentService = {
  send(req: AgentRequest): Promise<AgentReply> {
    return bridge().agent.send(req);
  },
  estimate(message: string): Promise<AgentEstimate> {
    return bridge().agent.estimate(message);
  },
  usage(): Promise<AgentUsage> {
    return bridge().agent.usage();
  },
};

export type { AgentMode, AgentMessage, AgentRequest, AgentReply, AgentEstimate, AgentUsage };
