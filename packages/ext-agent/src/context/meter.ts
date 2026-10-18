// sunday-agent — F4 Context Cockpit: live context meter.
//
// Tracks token usage by segment kind (system, rules, files, toolOutputs,
// history, pinned). Pure, no vscode import. Unit-tested.

import { estimateTokens } from './tokenizer.js';
import type { ContextSegment, ContextUsage, SegmentKind } from './types.js';

export const SEGMENT_KINDS: SegmentKind[] = [
  'system',
  'rules',
  'files',
  'toolOutputs',
  'history',
  'pinned',
];

/** Default model context windows (tokens). */
export const DEFAULT_CONTEXT_LIMITS: Record<string, number> = {
  auto: 128_000,
  'llama-3.3-70b': 128_000,
  'qwen-2.5-coder-32b': 32_768,
  'llama-3.1-8b': 128_000,
};

export interface MeterOptions {
  /** Model id — resolves the context limit. */
  modelId?: string;
  /** Explicit limit override (tokens). */
  limit?: number;
}

function emptyBreakdown(): Record<SegmentKind, number> {
  return { system: 0, rules: 0, files: 0, toolOutputs: 0, history: 0, pinned: 0 };
}

/**
 * ContextMeter: accumulate segments, read live usage.
 *
 * Usage:
 *   const meter = new ContextMeter({ modelId: 'auto' });
 *   meter.setSegment('system', systemPromptText);
 *   meter.addSegment({ id: 'rules-1', kind: 'rules', tokens: 512 });
 *   meter.getContextUsage(); // { used, limit, breakdown, percent, remaining }
 */
export class ContextMeter {
  private segments = new Map<string, ContextSegment>();
  private limit: number;

  constructor(opts: MeterOptions = {}) {
    this.limit =
      opts.limit ??
      DEFAULT_CONTEXT_LIMITS[opts.modelId ?? 'auto'] ??
      128_000;
  }

  /** Set the context window limit (e.g. when the model changes). */
  setLimit(limit: number): void {
    this.limit = limit;
  }

  getLimit(): number {
    return this.limit;
  }

  /** Upsert a segment by id. */
  setSegment(kind: SegmentKind, text: string, id?: string, label?: string): string {
    const segId = id ?? `${kind}-${Date.now()}`;
    this.segments.set(segId, { id: segId, kind, tokens: estimateTokens(text), label });
    return segId;
  }

  /** Upsert a pre-tokenized segment. */
  addSegment(seg: ContextSegment): void {
    this.segments.set(seg.id, seg);
  }

  /** Remove a segment by id. */
  removeSegment(id: string): boolean {
    return this.segments.delete(id);
  }

  /** Remove all segments of a kind. */
  clearKind(kind: SegmentKind): void {
    for (const [id, seg] of this.segments) {
      if (seg.kind === kind) this.segments.delete(id);
    }
  }

  /** Live usage reading. */
  getContextUsage(): ContextUsage {
    const breakdown = emptyBreakdown();
    let used = 0;
    for (const seg of this.segments.values()) {
      breakdown[seg.kind] += seg.tokens;
      used += seg.tokens;
    }
    return {
      used,
      limit: this.limit,
      breakdown,
      percent: this.limit > 0 ? used / this.limit : 0,
      remaining: Math.max(0, this.limit - used),
    };
  }

  /** All segments (for debugging / UI). */
  listSegments(): ContextSegment[] {
    return [...this.segments.values()];
  }
}
