/**
 * Typed access to the Sunday agent bridge (`window.sunday.agent`).
 *
 * INTEGRATION WAVE: the main-process side is now REAL — F1 estimator/
 * ledger/budgets, F2 loop guard, F4 context cockpit, F5 hybrid search,
 * F6 daemon sessions, F7 policy, F8 hooks, F9 evidence. See
 * electron/agentBackend.ts. No stubs.
 */
import type {
  SundayAPI,
  AgentMode,
  AgentMessage,
  AgentRequest,
  AgentReply,
  AgentEstimate,
  AgentUsage,
  ContextUsage,
  PinnedFact,
  CompactionPreview,
  PolicyEval,
  HookInfo,
  EvidenceSummary,
  LoopGuardStatus,
  LocalChatStatus,
  LocalModel,
  LocalProbeResult,
  OrgPolicySummary,
  OrgAuditEvent,
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
  estimate(message: string, model?: string): Promise<AgentEstimate> {
    return bridge().agent.estimate(message, model);
  },
  usage(): Promise<AgentUsage> {
    return bridge().agent.usage();
  },
  budgetContinue(scope: string, n: number): Promise<AgentUsage> {
    return bridge().agent.budgetContinue(scope, n);
  },
  // F2
  loopGuardStatus(): Promise<LoopGuardStatus> {
    return bridge().loopguard.status();
  },
  // F4
  contextMeter(): Promise<ContextUsage> {
    return bridge().context.meter();
  },
  pinFact(text: string): Promise<PinnedFact> {
    return bridge().context.pin(text);
  },
  unpinFact(id: string): Promise<boolean> {
    return bridge().context.unpin(id);
  },
  listPins(): Promise<PinnedFact[]> {
    return bridge().context.pins();
  },
  // F7
  evaluatePolicy(command: string, cwd: string): Promise<PolicyEval> {
    return bridge().policy.evaluate(command, cwd);
  },
  // F8
  listHooks(workspaceDir?: string): Promise<HookInfo[]> {
    return bridge().hooks.list(workspaceDir);
  },
  // F9
  evidence(diffText: string, goal: string): Promise<EvidenceSummary> {
    return bridge().evidence.get(diffText, goal);
  },
  // F14 — local-first chat (Ollama)
  localStatus(): Promise<LocalChatStatus> {
    return bridge().local.status();
  },
  localModels(): Promise<LocalModel[]> {
    return bridge().local.models();
  },
  localProbe(): Promise<LocalProbeResult> {
    return bridge().local.probe();
  },
  localPrivacy(): Promise<boolean> {
    return bridge().local.privacy();
  },
  setLocalPrivacy(on: boolean): Promise<boolean> {
    return bridge().local.setPrivacy(on);
  },
  // F15 — team governance
  orgLoad(workspaceDir?: string): Promise<OrgPolicySummary> {
    return bridge().org.load(workspaceDir);
  },
  orgLocked(key: string, workspaceDir?: string): Promise<boolean> {
    return bridge().org.locked(key, workspaceDir);
  },
  orgAudit(limit?: number): Promise<OrgAuditEvent[]> {
    return bridge().org.audit(limit);
  },
};

export type {
  AgentMode,
  AgentMessage,
  AgentRequest,
  AgentReply,
  AgentEstimate,
  AgentUsage,
  ContextUsage,
  PinnedFact,
  CompactionPreview,
  PolicyEval,
  HookInfo,
  EvidenceSummary,
  LoopGuardStatus,
  LocalChatStatus,
  LocalModel,
  LocalProbeResult,
  OrgPolicySummary,
  OrgAuditEvent,
};
