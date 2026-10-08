/**
 * @sunday/orchestrator — Best-of-N attempts (Group A, A2).
 *
 * Runs N parallel variants of the same goal with varied sampling
 * temperature (0.2 / 0.7 / 1.0 cycling) and varied system-prompt angles
 * (conservative / balanced / creative), then collects each attempt's diff
 * and changed files. The caller (sundayd's bestofn-methods, or tests)
 * injects the executor — this module owns only the fan-out, the
 * temperature/angle matrix, and result collection. Winner selection is a
 * UI concern (ext-agent comparison view); see `pickWinner`.
 */

export const BEST_OF_N_TEMPERATURES = [0.2, 0.7, 1.0] as const;
export const BEST_OF_N_ANGLES = ['conservative', 'balanced', 'creative'] as const;
export type BestOfNAngle = (typeof BEST_OF_N_ANGLES)[number];

/** Hard cap: 8 parallel agent turns is already a lot of spend. */
export const BEST_OF_N_MAX_ATTEMPTS = 8;

export interface BestOfNAttemptInput {
  attemptIndex: number;
  attemptId: string;
  temperature: number;
  angle: BestOfNAngle;
  /** Full system prompt for this variant (base + angle guidance). */
  systemPrompt: string;
  goal: string;
  workdir: string;
  signal?: AbortSignal;
}

export interface BestOfNAttemptResult {
  id: string;
  temperature: number;
  angle: BestOfNAngle;
  /** One-paragraph summary of what this attempt did. */
  summary: string;
  /** Unified diff of the attempt's changes (may be empty). */
  diff: string;
  filesChanged: string[];
  /** Present when the attempt failed instead of producing a diff. */
  error?: string;
}

/** Execute one variant; injected so the core stays UI/daemon-agnostic. */
export type BestOfNExecutor = (
  input: BestOfNAttemptInput,
) => Promise<Pick<BestOfNAttemptResult, 'summary' | 'diff' | 'filesChanged'>>;

export interface RunBestOfNOptions {
  goal: string;
  /** 1..BEST_OF_N_MAX_ATTEMPTS. */
  attempts: number;
  workdir: string;
  execute: BestOfNExecutor;
  /** Base system prompt; the angle guidance is appended per variant. */
  baseSystemPrompt?: string;
  signal?: AbortSignal;
}

const ANGLE_GUIDANCE: Record<BestOfNAngle, string> = {
  conservative:
    'Favor the smallest, safest change that satisfies the goal. ' +
    'Prefer established patterns in the codebase; avoid refactors, new ' +
    'dependencies, and clever tricks. Correctness over elegance.',
  balanced:
    'Solve the goal directly with clean, idiomatic code. A moderate amount ' +
    'of refactoring is fine when it clearly improves the result.',
  creative:
    'Explore the most effective solution, even if unconventional. Consider ' +
    'alternative approaches and pick the one with the best outcome, but ' +
    'keep the code maintainable and tested.',
};

/** System prompt for one variant: base + angle guidance. Exported for tests. */
export function buildAttemptSystemPrompt(angle: BestOfNAngle, base?: string): string {
  const guidance = `Attempt angle — ${angle}: ${ANGLE_GUIDANCE[angle]}`;
  return base ? `${base}\n\n${guidance}` : guidance;
}

/** Temperature/angle for attempt i (exported for tests). */
export function attemptConfig(index: number): { temperature: number; angle: BestOfNAngle } {
  return {
    temperature: BEST_OF_N_TEMPERATURES[index % BEST_OF_N_TEMPERATURES.length]!,
    angle: BEST_OF_N_ANGLES[index % BEST_OF_N_ANGLES.length]!,
  };
}

export interface RunBestOfNResult {
  attempts: BestOfNAttemptResult[];
}

/**
 * Run N variants in parallel. Individual failures are captured as
 * error-attempts — one bad variant never fails the whole batch. An empty
 * diff is a valid outcome (attempt did nothing), not an error.
 */
export async function runBestOfN(opts: RunBestOfNOptions): Promise<RunBestOfNResult> {
  const goal = opts.goal?.trim();
  if (!goal) throw new Error('runBestOfN: goal is required');
  const n = Math.floor(opts.attempts);
  if (!Number.isFinite(n) || n < 1 || n > BEST_OF_N_MAX_ATTEMPTS) {
    throw new Error(`runBestOfN: attempts must be 1..${BEST_OF_N_MAX_ATTEMPTS}`);
  }
  if (!opts.workdir) throw new Error('runBestOfN: workdir is required');

  const settled = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => {
      const attemptId = `attempt-${i + 1}`;
      const { temperature, angle } = attemptConfig(i);
      const input: BestOfNAttemptInput = {
        attemptIndex: i,
        attemptId,
        temperature,
        angle,
        systemPrompt: buildAttemptSystemPrompt(angle, opts.baseSystemPrompt),
        goal,
        workdir: opts.workdir,
        signal: opts.signal,
      };
      return opts.execute(input).then(
        (r): BestOfNAttemptResult => ({
          id: attemptId,
          temperature,
          angle,
          summary: r.summary,
          diff: r.diff ?? '',
          filesChanged: Array.isArray(r.filesChanged) ? r.filesChanged : [],
        }),
        (err): BestOfNAttemptResult => ({
          id: attemptId,
          temperature,
          angle,
          summary: '',
          diff: '',
          filesChanged: [],
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }),
  );

  // allSettled + the inner then() means these never reject, but stay
  // defensive: a synchronous executor throw becomes an error-attempt.
  return {
    attempts: settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            id: `attempt-${i + 1}`,
            temperature: attemptConfig(i).temperature,
            angle: attemptConfig(i).angle,
            summary: '',
            diff: '',
            filesChanged: [],
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          },
    ),
  };
}

/**
 * Validate a winner pick. Returns the winning attempt; throws on a bad
 * index or on picking a failed/empty attempt (the UI should prevent it,
 * this is the backstop).
 */
export function pickWinner(attempts: BestOfNAttemptResult[], index: number): BestOfNAttemptResult {
  if (!Number.isInteger(index) || index < 0 || index >= attempts.length) {
    throw new Error(`pickWinner: index ${index} out of range (0..${attempts.length - 1})`);
  }
  const winner = attempts[index]!;
  if (winner.error) {
    throw new Error(`pickWinner: attempt ${winner.id} failed (${winner.error})`);
  }
  return winner;
}
