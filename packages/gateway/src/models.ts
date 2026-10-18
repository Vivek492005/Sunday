/**
 * F3 — Model capability table (DATA, not code).
 *
 * Per-model facts the task-class router uses to build honest consent
 * prompts ("est. quality ↓, cost ↓"). Update this table when vendors change
 * models — no code changes needed.
 */
import type { RoutePolicy, TaskClass } from './policies.js';

/** Relative reasoning quality. strong > balanced > fast > tiny. */
export type QualityTier = 'strong' | 'balanced' | 'fast' | 'tiny';

export type CostTier = 'free' | 'low' | 'mid' | 'high';

export interface ModelCapability {
  /** Bare model id (provider prefix stripped). */
  id: string;
  contextLength: number;
  qualityTier: QualityTier;
  /** Model family — the `verify` class prefers a family different from the writer. */
  family: string;
  costTier: CostTier;
}

const RANK: Record<QualityTier, number> = { strong: 3, balanced: 2, fast: 1, tiny: 0 };
const COST_RANK: Record<CostTier, number> = { free: 0, low: 1, mid: 2, high: 3 };

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  'meta-llama/llama-3.3-70b-instruct': {
    id: 'meta-llama/llama-3.3-70b-instruct',
    contextLength: 128_000,
    qualityTier: 'strong',
    family: 'llama',
    costTier: 'low',
  },
  'llama-3.3-70b-versatile': {
    id: 'llama-3.3-70b-versatile',
    contextLength: 128_000,
    qualityTier: 'strong',
    family: 'llama',
    costTier: 'free',
  },
  'qwen/qwen-2.5-coder-32b-instruct': {
    id: 'qwen/qwen-2.5-coder-32b-instruct',
    contextLength: 32_768,
    qualityTier: 'balanced',
    family: 'qwen',
    costTier: 'low',
  },
  'meta-llama/llama-3.1-8b-instruct': {
    id: 'meta-llama/llama-3.1-8b-instruct',
    contextLength: 128_000,
    qualityTier: 'fast',
    family: 'llama',
    costTier: 'free',
  },
  'llama-3.1-8b-instant': {
    id: 'llama-3.1-8b-instant',
    contextLength: 128_000,
    qualityTier: 'fast',
    family: 'llama',
    costTier: 'free',
  },
  'openai/gpt-4o': {
    id: 'openai/gpt-4o',
    contextLength: 128_000,
    qualityTier: 'strong',
    family: 'gpt',
    costTier: 'high',
  },
  'openai/gpt-4o-mini': {
    id: 'openai/gpt-4o-mini',
    contextLength: 128_000,
    qualityTier: 'fast',
    family: 'gpt',
    costTier: 'mid',
  },
  'anthropic/claude-3.5-sonnet': {
    id: 'anthropic/claude-3.5-sonnet',
    contextLength: 200_000,
    qualityTier: 'strong',
    family: 'claude',
    costTier: 'high',
  },
  'google/gemini-2.0-flash-001': {
    id: 'google/gemini-2.0-flash-001',
    contextLength: 1_048_576,
    qualityTier: 'balanced',
    family: 'gemini',
    costTier: 'low',
  },
  'google/gemini-2.0-flash-lite-001': {
    id: 'google/gemini-2.0-flash-lite-001',
    contextLength: 1_048_576,
    qualityTier: 'tiny',
    family: 'gemini',
    costTier: 'free',
  },
  'deepseek/deepseek-chat': {
    id: 'deepseek/deepseek-chat',
    contextLength: 64_000,
    qualityTier: 'balanced',
    family: 'deepseek',
    costTier: 'low',
  },
};

export function getCapability(bareModelId: string): ModelCapability | undefined {
  return MODEL_CAPABILITIES[bareModelId];
}

/**
 * Human-readable quality/cost delta for a consent prompt, e.g.
 * "est. quality ↓, cost ↓". Unknown models degrade gracefully to "".
 */
export function qualityNote(fromBareModel: string, toBareModel: string): string {
  const from = getCapability(fromBareModel);
  const to = getCapability(toBareModel);
  if (!from || !to) return '';
  const parts: string[] = [];
  if (RANK[to.qualityTier] < RANK[from.qualityTier]) parts.push('est. quality ↓');
  else if (RANK[to.qualityTier] > RANK[from.qualityTier]) parts.push('est. quality ↑');
  if (COST_RANK[to.costTier] < COST_RANK[from.costTier]) parts.push('cost ↓');
  else if (COST_RANK[to.costTier] > COST_RANK[from.costTier]) parts.push('cost ↑');
  return parts.join(', ');
}

/**
 * Sensible default per-task-class policies. Callers (server config, sundayd)
 * override with their own RoutePolicy[] — these are the fallback when none
 * are supplied.
 *
 * Mapping per spec: plan/architect → strong reasoning; edit/apply → fast
 * cheap; autocomplete → tiny; verify → independent family (qwen, not llama).
 */
export const DEFAULT_ROUTE_POLICIES: RoutePolicy[] = [
  {
    taskClass: 'plan',
    primary: 'sunday:meta-llama/llama-3.3-70b-instruct',
    fallbacks: ['openrouter:meta-llama/llama-3.3-70b-instruct'],
    downgrade: 'ask',
  },
  {
    taskClass: 'architect',
    primary: 'sunday:meta-llama/llama-3.3-70b-instruct',
    fallbacks: ['openrouter:meta-llama/llama-3.3-70b-instruct'],
    downgrade: 'ask',
  },
  {
    taskClass: 'edit',
    primary: 'groq:llama-3.3-70b-versatile',
    fallbacks: ['openrouter:qwen/qwen-2.5-coder-32b-instruct'],
    downgrade: 'ask',
  },
  {
    taskClass: 'apply',
    primary: 'groq:llama-3.3-70b-versatile',
    fallbacks: ['openrouter:qwen/qwen-2.5-coder-32b-instruct'],
    downgrade: 'ask',
  },
  {
    taskClass: 'autocomplete',
    primary: 'groq:llama-3.1-8b-instant',
    fallbacks: [],
    downgrade: 'auto',
  },
  {
    taskClass: 'verify',
    primary: 'openrouter:qwen/qwen-2.5-coder-32b-instruct',
    fallbacks: ['groq:llama-3.1-8b-instant'],
    downgrade: 'ask',
  },
  {
    taskClass: 'default',
    primary: 'sunday:meta-llama/llama-3.3-70b-instruct',
    fallbacks: [
      'openrouter:meta-llama/llama-3.3-70b-instruct',
      'groq:llama-3.3-70b-versatile',
    ],
    downgrade: 'ask',
  },
];

export function policyForTaskClass(
  policies: RoutePolicy[] | undefined,
  taskClass: TaskClass,
): RoutePolicy | undefined {
  return policies?.find((p) => p.taskClass === taskClass);
}
