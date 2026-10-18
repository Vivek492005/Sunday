// @sunday/eval — F12 × F2: loop-trigger counting.
//
// Replays a task transcript through the REAL F2 LoopGuard (from the built
// @sunday/ext-agent package) and counts how many times the breaker trips.
// This is what the scoreboard's "loop-trigger rate" column measures.
//
// The ext-agent build is loaded lazily via dynamic import (same pattern as
// the parallel-quota-fairness task's gateway import) so the eval package
// needs no new workspace dependency or lockfile churn. When the build is
// absent, loop data is reported as unknown (0 with `available: false`) —
// never fabricated.

import type { ExecutedCall } from './types.js';

export interface LoopCount {
  /** Number of LoopGuard trips while replaying the transcript. */
  triggers: number;
  /** False when the ext-agent build was unavailable (data unknown). */
  available: boolean;
}

interface LoopGuardModule {
  LoopGuard: new (policy?: Record<string, unknown>) => {
    preCall(
      tool: string,
      args: Record<string, unknown>,
    ): { token: unknown; trigger?: unknown };
    postResult(
      token: unknown,
      result: { tool: string; isError: boolean; resultText?: string },
    ): unknown;
  };
}

let cachedModule: LoopGuardModule | null = null;
let loadFailed = false;

async function loadLoopGuard(): Promise<LoopGuardModule | null> {
  if (cachedModule || loadFailed) return cachedModule;
  try {
    const url = new URL('../../ext-agent/dist/loopGuard/index.js', import.meta.url);
    const mod = (await import(url.href)) as LoopGuardModule | null;
    if (mod && typeof mod.LoopGuard === 'function') {
      cachedModule = mod;
    } else {
      loadFailed = true;
    }
  } catch {
    loadFailed = true;
  }
  return cachedModule;
}

/**
 * Count F2 LoopGuard trips for one task transcript.
 * A fresh guard per task (mirrors one agent turn).
 */
export async function countLoopTriggers(transcript: ExecutedCall[]): Promise<LoopCount> {
  const mod = await loadLoopGuard();
  if (!mod) return { triggers: 0, available: false };
  const guard = new mod.LoopGuard();
  let triggers = 0;
  for (const call of transcript) {
    const { token, trigger } = guard.preCall(call.tool, call.args);
    if (trigger) triggers += 1;
    const output =
      typeof call.result?.output === 'string' ? call.result.output : undefined;
    const post = guard.postResult(token, {
      tool: call.tool,
      isError: !call.valid,
      resultText: output,
    });
    if (post) triggers += 1;
  }
  return { triggers, available: true };
}
