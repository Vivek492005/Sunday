// @sunday/eval — F12 × F3: eval → router quality-tier feed.
//
// The scoreboard is product input, not just marketing: per-model eval
// results feed the F3 task-class router's model quality tiers. This module
// builds the JSON feed (`eval-quality-tiers.json`, written by the nightly
// eval CI job); the gateway consumes it via `applyEvalTiers` in
// packages/gateway/src/models.ts.
//
// The tier vocabulary ('strong' | 'balanced' | 'fast' | 'tiny') mirrors the
// gateway's QualityTier so the JSON needs no translation layer.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelScore } from './scoreboard.js';

/** Mirrors the gateway's QualityTier (kept in sync by contract, not import). */
export type EvalQualityTier = 'strong' | 'balanced' | 'fast' | 'tiny';

export interface ModelQualityFeedEntry {
  /** Bare model id (provider prefix stripped), matching the gateway table. */
  model: string;
  passRate: number;
  runs: number;
  totalTasks: number;
  costPerSuccessfulTaskUsd?: number;
  costPerSuccessfulTaskRequests?: number;
  loopTriggerRate: number;
  suggestedTier: EvalQualityTier;
}

export interface ModelQualityFeed {
  generatedAt: string;
  packVersion: number;
  entries: ModelQualityFeedEntry[];
}

/**
 * Map a pooled pass rate to a quality tier. Thresholds are DATA — tune
 * them as the task pack grows; the mapping itself stays total.
 */
export function suggestedQualityTier(passRate: number): EvalQualityTier {
  if (passRate >= 0.9) return 'strong';
  if (passRate >= 0.75) return 'balanced';
  if (passRate >= 0.55) return 'fast';
  return 'tiny';
}

/** Build the router feed from scoreboard aggregates. Pure. */
export function buildModelQualityFeed(
  scores: ModelScore[],
  generatedAt: string = new Date().toISOString(),
): ModelQualityFeed {
  return {
    generatedAt,
    packVersion: scores[0]?.packVersion ?? 0,
    entries: scores.map((s) => ({
      model: s.model,
      passRate: s.passRate,
      runs: s.runs,
      totalTasks: s.total,
      costPerSuccessfulTaskUsd: s.costPerSuccessfulTaskUsd,
      costPerSuccessfulTaskRequests: s.costPerSuccessfulTaskRequests,
      loopTriggerRate: s.loopTriggerRate,
      suggestedTier: suggestedQualityTier(s.passRate),
    })),
  };
}

/** Write the feed JSON (consumed by the gateway / F3 router). */
export function writeQualityFeed(
  scores: ModelScore[],
  outPath: string,
  generatedAt: string = new Date().toISOString(),
): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(buildModelQualityFeed(scores, generatedAt), null, 2));
}
