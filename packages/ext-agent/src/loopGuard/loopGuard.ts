// sunday-agent — F2 Loop Breaker: LoopGuard.
//
// A circuit breaker for runaway agent loops. Pure logic: no vscode import,
// no node imports, no I/O — the host (sundayd's AgentLoop) feeds it tool
// calls via preCall/postResult and reacts to triggers.
//
// Detectors (spec §F2):
//  1. repeated-tool-args    — same tool + near-identical args ≥ threshold
//  2. repeated-failure      — same normalized error signature ≥ threshold
//  3. apply-revert-pingpong — edit/write calls alternating between two
//                             content states on the same path ≥ threshold
//  4. spend-no-progress     — tokens burned with no files changed and no
//                             tests passed (divergence)
//
// Semantics: once tripped, the breaker stays open — preCall/postResult keep
// returning undefined — until acknowledge() (user picked an action) or
// reset() (new turn).

import { errorSignature, hashString, hashToolCall, normalizeArgs } from './hash.js';
import {
  DEFAULT_LOOP_GUARD_POLICY,
  type LoopGuardDetectorKind,
  type LoopGuardPolicy,
  type LoopGuardSuggestedAction,
  type LoopGuardTrigger,
  type ToolCallRecord,
  type ToolResultInput,
} from './types.js';

/** Tools whose success means "a file actually changed". */
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file']);

/** run_terminal counts as a test run when the command looks like one. */
const TEST_COMMAND_HINT = /(^|[\s;&|])(npm test|pnpm test|yarn test|vitest|jest|pytest|go test|cargo test|phpunit|rspec)\b/i;

/** Opaque token correlating preCall → postResult. */
export interface CallToken {
  readonly __loopGuardToken: unique symbol;
}

interface PendingCall {
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  filePath?: string;
  contentHash?: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Heuristic progress signals from a finished tool call. Exported (and
 * tested) separately so hosts can see exactly what counts as "progress".
 */
export function inferProgressSignals(
  tool: string,
  args: Record<string, unknown>,
  isError: boolean,
): { filesChanged: number; testsPassed: boolean } {
  if (isError) return { filesChanged: 0, testsPassed: false };
  const filesChanged = MUTATING_TOOLS.has(tool) ? 1 : 0;
  let testsPassed = false;
  if (tool === 'run_terminal') {
    const cmd = (args as { command?: unknown }).command;
    if (typeof cmd === 'string' && TEST_COMMAND_HINT.test(cmd)) testsPassed = true;
  }
  return { filesChanged, testsPassed };
}

const SUGGESTED: LoopGuardSuggestedAction[] = [
  'change-strategy',
  'retry-stronger-model',
  'ask-user',
];

export class LoopGuard {
  readonly policy: LoopGuardPolicy;
  private window: ToolCallRecord[] = [];
  private pending: PendingCall | undefined;
  private open = false;

  constructor(policy?: Partial<LoopGuardPolicy>) {
    this.policy = { ...DEFAULT_LOOP_GUARD_POLICY, ...policy };
  }

  get tripped(): boolean {
    return this.open;
  }

  /** Records kept in the sliding window (oldest → newest); for tests/debug. */
  snapshot(): readonly ToolCallRecord[] {
    return this.window;
  }

  /** New turn: forget history, re-arm the breaker. */
  reset(): void {
    this.window = [];
    this.pending = undefined;
    this.open = false;
  }

  /** User chose one of the suggested actions: re-arm, keep history. */
  acknowledge(): void {
    this.open = false;
  }

  /**
   * Call BEFORE executing a tool. Returns a token for postResult, plus a
   * trigger when detectors (1) or (3) fire on this pending call.
   */
  preCall(tool: string, args: Record<string, unknown>): { token: CallToken; trigger?: LoopGuardTrigger } {
    if (!this.policy.enabled || this.open) {
      // Breaker open/disabled: still hand out a token so postResult stays
      // balanced, but record nothing.
      return { token: {} as CallToken };
    }
    const argsHash = hashToolCall(tool, args);
    const { filePath, contentHash } = extractFileSignal(tool, args);
    this.pending = { tool, args, argsHash, filePath, contentHash, inputTokens: 0, outputTokens: 0 };
    const trigger =
      this.detectRepeatedToolArgs(tool, argsHash) ?? this.detectPingPong(tool, filePath, contentHash);
    if (trigger) this.open = true;
    return { token: {} as CallToken, trigger };
  }

  /**
   * Call AFTER a tool result. Returns a trigger when detectors (2) or (4)
   * fire on the completed call.
   */
  postResult(token: CallToken, result: ToolResultInput): LoopGuardTrigger | undefined {
    void token;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return undefined;
    if (!this.policy.enabled || this.open) return undefined;

    const sig = result.isError && result.resultText ? errorSignature(result.resultText) : undefined;
    const progress = inferProgressSignals(pending.tool, pending.args, result.isError);
    const record: ToolCallRecord = {
      tool: pending.tool,
      argsHash: pending.argsHash,
      errorSignature: sig,
      isError: result.isError,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      filesChanged: progress.filesChanged,
      testsPassed: progress.testsPassed,
      filePath: pending.filePath,
      contentHash: pending.contentHash,
      timestamp: Date.now(),
    };
    this.window.push(record);
    if (this.window.length > this.policy.windowSize) {
      this.window.splice(0, this.window.length - this.policy.windowSize);
    }
    const trigger = this.detectRepeatedFailure() ?? this.detectSpendDivergence();
    if (trigger) this.open = true;
    return trigger;
  }

  // ——— detectors ———

  /** (1) same tool + near-identical args ≥ threshold (pending call included). */
  private detectRepeatedToolArgs(tool: string, argsHash: string): LoopGuardTrigger | undefined {
    // +1 for the pending call itself.
    const count = 1 + this.window.filter((r) => r.tool === tool && r.argsHash === argsHash).length;
    if (count < this.policy.threshold) return undefined;
    return this.trip('repeated-tool-args', count,
      `LoopGuard: \`${tool}\` called ${count}× with identical arguments — the agent looks stuck.`,
      { tool, argsHash });
  }

  /** (2) same normalized failure signature ≥ threshold. */
  private detectRepeatedFailure(): LoopGuardTrigger | undefined {
    const last = this.window[this.window.length - 1];
    if (!last?.isError || !last.errorSignature) return undefined;
    const count = this.window.filter(
      (r) => r.isError && r.errorSignature === last.errorSignature,
    ).length;
    if (count < this.policy.threshold) return undefined;
    return this.trip('repeated-failure', count,
      `LoopGuard: the same failure repeated ${count}× — retrying is burning quota.`,
      { tool: last.tool, errorSignature: last.errorSignature });
  }

  /**
   * (3) apply–revert ping-pong: trailing edit/write calls on one path
   * alternating between exactly two content states, run length ≥ threshold.
   */
  private detectPingPong(
    tool: string,
    filePath: string | undefined,
    contentHash: string | undefined,
  ): LoopGuardTrigger | undefined {
    if (!filePath || !contentHash || !MUTATING_TOOLS.has(tool)) return undefined;
    // Trailing run of same-tool+same-path records (oldest → newest), plus
    // the pending call appended.
    const seq: string[] = [];
    for (let i = this.window.length - 1; i >= 0; i--) {
      const r = this.window[i];
      if (r.tool !== tool || r.filePath !== filePath || !r.contentHash) break;
      seq.unshift(r.contentHash);
    }
    seq.push(contentHash);
    if (seq.length < this.policy.threshold) return undefined;
    const distinct = new Set(seq);
    if (distinct.size !== 2) return undefined;
    // Strict alternation: seq[i] === seq[i % 2] for all i.
    for (let i = 0; i < seq.length; i++) {
      if (seq[i] !== seq[i % 2]) return undefined;
    }
    return this.trip('apply-revert-pingpong', seq.length,
      `LoopGuard: \`${tool}\` on \`${filePath}\` is flip-flopping between two states (${seq.length}×) — apply/revert ping-pong.`,
      { tool, filePath });
  }

  /**
   * (4) spend vs progress divergence: tokens burned in the window with no
   * files changed and no tests passed.
   */
  private detectSpendDivergence(): LoopGuardTrigger | undefined {
    if (this.window.length < this.policy.divergenceMinCalls) return undefined;
    let tokens = 0;
    let filesChanged = 0;
    let testsPassed = 0;
    for (const r of this.window) {
      tokens += r.inputTokens + r.outputTokens;
      filesChanged += r.filesChanged;
      if (r.testsPassed) testsPassed++;
    }
    if (tokens < this.policy.divergenceMinTokens) return undefined;
    if (filesChanged > 0 || testsPassed > 0) return undefined;
    return this.trip('spend-no-progress', this.window.length,
      `LoopGuard: ~${tokens.toLocaleString('en-US')} tokens spent across ${this.window.length} calls with no files changed and no tests passed.`,
      { windowTokens: tokens });
  }

  private trip(
    kind: LoopGuardDetectorKind,
    count: number,
    message: string,
    evidence: LoopGuardTrigger['evidence'],
  ): LoopGuardTrigger {
    return {
      kind,
      count,
      threshold: this.policy.threshold,
      message,
      evidence,
      suggestedActions: SUGGESTED,
    };
  }
}

/** Pull (path, content-hash) out of edit/write tool args; undefined otherwise. */
function extractFileSignal(
  tool: string,
  args: Record<string, unknown>,
): { filePath?: string; contentHash?: string } {
  if (!MUTATING_TOOLS.has(tool)) return {};
  const filePath = (args as { path?: unknown }).path;
  if (typeof filePath !== 'string' || !filePath) return {};
  const a = args as { content?: unknown; newText?: unknown; new_text?: unknown };
  const content = a.content ?? a.newText ?? a.new_text;
  const contentHash =
    typeof content === 'string'
      ? hashString(`content\n${content}`)
      : hashString(`args\n${normalizeArgs(args)}`);
  return { filePath, contentHash };
}
