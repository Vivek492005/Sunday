// sunday-agent — canonical Sunday model list (single source of truth).
//
// The 4 Sunday models were defined in THREE places (sundayModelProvider.ts,
// lmProvider.ts, chatView.ts FALLBACK_MODELS) and could drift. This module
// is the one canonical list — all consumers import from here.
//
// Phase 3 (2026-10-12): consolidated for robustness.

/** A Sunday model definition. */
export interface SundayModel {
  /** Stable id, e.g. 'auto', 'llama-3.3-70b'. */
  id: string;
  /** Display name with emoji, e.g. '⚡ Auto'. */
  name: string;
  /** Short label for pickers, e.g. '⚡ Auto (recommended)'. */
  label: string;
  /** Model family for vscode.lm. */
  family: string;
  /** Model version string. */
  version: string;
  /** Tooltip text (user-facing, Hinglish ok). */
  tooltip: string;
  /** Gateway model ref, e.g. 'sunday:meta-llama/llama-3.3-70b-instruct'. */
  ref: string;
  /** Provider key for the chat webview picker. */
  provider: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

/** The 4 Sunday models. Order = display order in pickers. */
export const SUNDAY_MODELS: ReadonlyArray<SundayModel> = [
  {
    id: 'auto',
    name: '⚡ Auto',
    label: '⚡ Auto (recommended)',
    family: 'sunday-auto',
    version: '1.0',
    tooltip: 'Sunday Auto — speed + quality ka best balance (recommended)',
    ref: 'groq:llama-3.1-8b-instant',
    provider: 'sunday',
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
  },
  {
    id: 'llama-3.3-70b',
    name: '🧠 Llama 3.3 70B',
    label: '🧠 Llama 3.3 70B (best quality)',
    family: 'sunday-llama',
    version: '3.3',
    tooltip: 'Sunday Llama 3.3 70B — best quality, mushkil problems ke liye',
    ref: 'sunday:meta-llama/llama-3.3-70b-instruct',
    provider: 'sunday',
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
  },
  {
    id: 'qwen-2.5-coder-32b',
    name: '💻 Qwen 2.5 Coder 32B',
    label: '💻 Qwen 2.5 Coder 32B (best for code)',
    family: 'sunday-qwen',
    version: '2.5',
    tooltip: 'Sunday Qwen 2.5 Coder 32B — coding ke liye best',
    ref: 'openrouter:qwen/qwen-2.5-coder-32b-instruct',
    provider: 'openrouter',
    maxInputTokens: 32000,
    maxOutputTokens: 8192,
  },
  {
    id: 'llama-3.1-8b',
    name: '🚀 Llama 3.1 8B',
    label: '🚀 Llama 3.1 8B (fastest)',
    family: 'sunday-llama',
    version: '3.1',
    tooltip: 'Sunday Llama 3.1 8B — sabse fast, chhote kaamon ke liye',
    ref: 'groq:llama-3.1-8b-instant',
    provider: 'groq',
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
  },
];

/** Find a model by id, falling back to Auto. */
export function findSundayModel(id: string | undefined): SundayModel {
  return SUNDAY_MODELS.find((m) => m.id === id) ?? SUNDAY_MODELS[0];
}
