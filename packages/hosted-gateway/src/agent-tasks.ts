/**
 * @sunday/hosted-gateway — async agent tasks (Group A, A1).
 *
 * Lets a signed-in IDE queue a long-running agent prompt on the gateway;
 * the user's own sundayd (CloudTaskRunner) claims queued tasks, executes
 * them through the local agent pipeline, and posts the result back.
 *
 * Ownership is by authenticated identity (`key.id` — the namespaced social,
 * session, or API-key id): a task is only ever visible to the identity that
 * created it. The store is a single JSON file (`agent-tasks.json`, mode
 * 0600) in the gateway data dir; writes are atomic (tmp + rename) and the
 * file is never logged.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type AgentTaskStatus = 'queued' | 'claimed' | 'completed' | 'failed';

/** Stored task record. */
export interface AgentTask {
  id: string;
  /** Namespaced auth identity that owns the task (never exposed publicly). */
  userId: string;
  prompt: string;
  repoContext?: string;
  status: AgentTaskStatus;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

/** Public shape returned by the API (no userId). */
export type PublicAgentTask = Omit<AgentTask, 'userId'>;

export const AGENT_TASK_PROMPT_MAX = 8000;
export const AGENT_TASK_REPO_CONTEXT_MAX = 4000;
export const AGENT_TASK_RESULT_MAX = 200_000;
/** Completed/failed tasks older than this are pruned on write. */
const TASK_TTL_MS = 7 * 24 * 60 * 60_000;
/** Hard per-user cap (oldest terminal tasks evicted first). */
const MAX_TASKS_PER_USER = 200;

/**
 * Validate a create-task payload. Returns a list of problems (empty = ok).
 */
export function validateTaskInput(prompt: unknown, repoContext: unknown): string[] {
  const problems: string[] = [];
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    problems.push('prompt is required and must be a non-empty string');
  } else if (prompt.length > AGENT_TASK_PROMPT_MAX) {
    problems.push(`prompt exceeds ${AGENT_TASK_PROMPT_MAX} characters`);
  }
  if (repoContext !== undefined && repoContext !== null) {
    if (typeof repoContext !== 'string') {
      problems.push('repo_context must be a string when provided');
    } else if (repoContext.length > AGENT_TASK_REPO_CONTEXT_MAX) {
      problems.push(`repo_context exceeds ${AGENT_TASK_REPO_CONTEXT_MAX} characters`);
    }
  }
  return problems;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export class AgentTaskStore {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly now: () => number;

  constructor(
    private readonly dataDir: string,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.load();
  }

  private file(): string {
    return join(this.dataDir, 'agent-tasks.json');
  }

  private load(): void {
    const f = this.file();
    if (!existsSync(f)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(f, 'utf8'));
      if (!Array.isArray(raw)) return;
      for (const t of raw) {
        if (isRecord(t) && typeof t.id === 'string' && typeof t.userId === 'string') {
          this.tasks.set(t.id, t as unknown as AgentTask);
        }
      }
    } catch {
      // Corrupt store must never crash the gateway; start empty and let the
      // next persist overwrite it.
    }
  }

  private persist(): void {
    const cutoff = this.now() - TASK_TTL_MS;
    const kept: AgentTask[] = [];
    for (const t of this.tasks.values()) {
      const terminal = t.status === 'completed' || t.status === 'failed';
      const finishedAt = t.completedAt ? Date.parse(t.completedAt) : NaN;
      if (terminal && !Number.isNaN(finishedAt) && finishedAt < cutoff) continue;
      kept.push(t);
    }
    // Per-user cap: drop oldest terminal tasks first.
    const byUser = new Map<string, AgentTask[]>();
    for (const t of kept) {
      const arr = byUser.get(t.userId) ?? [];
      arr.push(t);
      byUser.set(t.userId, arr);
    }
    const final: AgentTask[] = [];
    for (const arr of byUser.values()) {
      arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const terminal = arr.filter((t) => t.status === 'completed' || t.status === 'failed');
      const live = arr.filter((t) => t.status === 'queued' || t.status === 'claimed');
      const drop = Math.max(0, live.length + terminal.length - MAX_TASKS_PER_USER);
      final.push(...live, ...terminal.slice(drop));
    }
    this.tasks.clear();
    for (const t of final) this.tasks.set(t.id, t);
    const tmp = join(this.dataDir, `agent-tasks.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(final, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file());
    chmodSync(this.file(), 0o600);
  }

  create(userId: string, prompt: string, repoContext?: string): AgentTask {
    const task: AgentTask = {
      id: `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      userId,
      prompt,
      ...(repoContext ? { repoContext } : {}),
      status: 'queued',
      createdAt: new Date(this.now()).toISOString(),
    };
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  /** Newest first, owned by userId only. */
  list(userId: string): AgentTask[] {
    return [...this.tasks.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Returns the task only when owned by userId. */
  get(userId: string, id: string): AgentTask | undefined {
    const t = this.tasks.get(id);
    return t && t.userId === userId ? t : undefined;
  }

  /**
   * queued → claimed. Returns undefined when the task doesn't exist, isn't
   * owned, or isn't queued (double-claim → undefined, not an error state
   * change).
   */
  claim(userId: string, id: string): AgentTask | undefined {
    const t = this.get(userId, id);
    if (!t || t.status !== 'queued') return undefined;
    t.status = 'claimed';
    t.claimedAt = new Date(this.now()).toISOString();
    this.persist();
    return t;
  }

  /**
   * claimed/queued → completed|failed. Returns undefined when the task
   * doesn't exist, isn't owned, or is already terminal.
   */
  complete(
    userId: string,
    id: string,
    outcome: { result?: string; error?: string },
  ): AgentTask | undefined {
    const t = this.get(userId, id);
    if (!t || t.status === 'completed' || t.status === 'failed') return undefined;
    const result = typeof outcome.result === 'string' ? outcome.result.slice(0, AGENT_TASK_RESULT_MAX) : undefined;
    const error = typeof outcome.error === 'string' ? outcome.error.slice(0, 4000) : undefined;
    t.status = error ? 'failed' : 'completed';
    if (result !== undefined) t.result = result;
    if (error !== undefined) t.error = error;
    t.completedAt = new Date(this.now()).toISOString();
    this.persist();
    return t;
  }

  /** Number of stored tasks (tests/health). */
  size(): number {
    return this.tasks.size;
  }
}

/** Strip the internal owner id before responding. */
export function publicTask(t: AgentTask): PublicAgentTask {
  const { userId: _userId, ...pub } = t;
  return pub;
}
