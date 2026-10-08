/**
 * @sunday/sundayd — Best-of-N methods (Group A, A2).
 *
 * Registers `bestofn/run`: run N parallel variants of one goal, each in
 * its own git worktree on a dedicated `sunday/bestofn/*` branch, with
 * cycled temperature (0.2/0.7/1.0) and varied system-prompt angles
 * (conservative/balanced/creative). Returns per-attempt diffs; the IDE
 * comparison view lets the user pick a winner, applied via the existing
 * `worktree/merge`.
 *
 * Wiring follows the manager.ts pattern: `registerBestOfNMethods(deps)`
 * so cli.ts stays the only place that touches daemon construction.
 * sundayd never imports @sunday/orchestrator (one-directional edge) — the
 * temperature/angle matrix is replicated here and documented as such.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ChatEvent } from '@sunday/protocol';
import type { ToolRegistry } from '@sunday/tools';
import { WorktreeManager } from './worktrees.js';

const execFileAsync = promisify(execFile);

/** Temperature/angle matrix — mirrors @sunday/orchestrator's best-of-n. */
export const BESTOFN_TEMPERATURES = [0.2, 0.7, 1.0];
export const BESTOFN_ANGLES = ['conservative', 'balanced', 'creative'] as const;
export type BestOfNAngle = (typeof BESTOFN_ANGLES)[number];
export const BESTOFN_MAX_ATTEMPTS = 8;

const ANGLE_GUIDANCE: Record<BestOfNAngle, string> = {
  conservative:
    'Favor the smallest, safest change that satisfies the goal. Prefer established ' +
    'patterns in the codebase; avoid refactors, new dependencies, and clever tricks.',
  balanced:
    'Solve the goal directly with clean, idiomatic code. A moderate amount of ' +
    'refactoring is fine when it clearly improves the result.',
  creative:
    'Explore the most effective solution, even if unconventional. Keep the code ' +
    'maintainable and tested.',
};

export interface BestOfNAttempt {
  id: string;
  temperature: number;
  angle: BestOfNAngle;
  summary: string;
  diff: string;
  filesChanged: string[];
  worktree: string;
  branch: string;
  error?: string;
}

/** Structural subset of the daemon's orchestrator host (runSubAgent). */
export interface BestOfNHost {
  runSubAgent(opts: {
    title: string;
    cwd: string;
    model?: string;
    systemPrompt: string;
    prompt: string;
    tools: ToolRegistry;
    maxIterations: number;
    temperature?: number;
    signal?: AbortSignal;
    onEvent: (event: ChatEvent) => void;
  }): Promise<void>;
  tools: ToolRegistry;
}

export interface RegisterBestOfNMethodsDeps {
  addMethod: (name: string, handler: (params: unknown) => Promise<unknown>) => void;
  host: BestOfNHost;
  worktrees?: WorktreeManager;
  log?: (msg: string) => void;
}

function parseRunParams(params: unknown): { goal: string; attempts: number; workdir: string } {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('bestofn/run: params must be an object');
  }
  const p = params as Record<string, unknown>;
  const goal = typeof p.goal === 'string' ? p.goal.trim() : '';
  if (!goal) throw new Error('bestofn/run: goal is required');
  if (goal.length > 8000) throw new Error('bestofn/run: goal exceeds 8000 characters');
  const attempts = p.attempts === undefined ? 3 : p.attempts;
  if (!Number.isInteger(attempts) || (attempts as number) < 1 || (attempts as number) > BESTOFN_MAX_ATTEMPTS) {
    throw new Error(`bestofn/run: attempts must be an integer 1..${BESTOFN_MAX_ATTEMPTS}`);
  }
  const workdir = typeof p.workdir === 'string' ? p.workdir : '';
  if (!workdir) throw new Error('bestofn/run: workdir is required');
  return { goal, attempts: attempts as number, workdir };
}

async function gitDiff(worktreePath: string): Promise<{ diff: string; filesChanged: string[] }> {
  const diff = await execFileAsync('git', ['diff', 'HEAD', '--', '.'], {
    cwd: worktreePath,
    maxBuffer: 32 * 1024 * 1024,
  }).then((r) => r.stdout, () => '');
  const names = await execFileAsync('git', ['diff', '--name-only', 'HEAD', '--', '.'], {
    cwd: worktreePath,
    maxBuffer: 4 * 1024 * 1024,
  }).then((r) => r.stdout.split('\n').map((s) => s.trim()).filter(Boolean), () => []);
  return { diff, filesChanged: names };
}

/** Last 1000 chars of streamed text — the agent is asked to end with a summary. */
function summarize(text: string): string {
  const t = text.trim();
  if (!t) return '(no output)';
  return t.length > 1000 ? '…' + t.slice(-1000) : t;
}

export function registerBestOfNMethods(deps: RegisterBestOfNMethodsDeps): void {
  const worktrees = deps.worktrees ?? new WorktreeManager();
  const log = deps.log ?? (() => undefined);

  deps.addMethod('bestofn/run', async (params) => {
    const { goal, attempts, workdir } = parseRunParams(params);

    const results = await Promise.all(
      Array.from({ length: attempts }, async (_, i): Promise<BestOfNAttempt> => {
        const id = `attempt-${i + 1}`;
        const temperature = BESTOFN_TEMPERATURES[i % BESTOFN_TEMPERATURES.length]!;
        const angle = BESTOFN_ANGLES[i % BESTOFN_ANGLES.length]!;
        const branch = `sunday/bestofn/${randomUUID().slice(0, 8)}`;
        const base: BestOfNAttempt = {
          id, temperature, angle, summary: '', diff: '', filesChanged: [],
          worktree: '', branch,
        };
        let wtPath = '';
        try {
          const wt = await worktrees.add({ repoRoot: workdir, branch });
          wtPath = wt.path;
          base.worktree = wtPath;
        } catch (e) {
          // Not a git repo (or git failed) — record the failure, keep going.
          return { ...base, error: `worktree setup failed: ${(e as Error).message}` };
        }
        let streamed = '';
        try {
          await deps.host.runSubAgent({
            title: `best-of-n ${id} (${angle}, t=${temperature})`,
            cwd: wtPath,
            systemPrompt:
              `You are Sunday, an autonomous coding assistant. Complete the task below in the working directory. ` +
              `When finished, end your response with a concise summary of what you changed.\n\n` +
              `Attempt angle — ${angle}: ${ANGLE_GUIDANCE[angle]}`,
            prompt: goal,
            tools: deps.host.tools,
            maxIterations: 25,
            temperature,
            onEvent: (event) => {
              if (event.type === 'text-delta') streamed += event.delta;
            },
          });
          const { diff, filesChanged } = await gitDiff(wtPath);
          return { ...base, summary: summarize(streamed), diff, filesChanged };
        } catch (e) {
          log(`bestofn ${id} failed: ${(e as Error).message}`);
          return { ...base, summary: summarize(streamed), error: (e as Error).message };
        }
      }),
    );
    return { attempts: results };
  });
}
