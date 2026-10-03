import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@sunday/protocol';
import {
  BACKGROUND_METHODS,
  backgroundRunStateSchema,
  type BackgroundEvent,
  type BackgroundMethodName,
  type BackgroundRunState,
  type BackgroundRunStatus,
} from '@sunday/protocol';
import { BackgroundAgentError } from './errors.js';
import type { OrchestratorHost, OrchestrationMethodHandler } from './host.js';

/**
 * @sunday/orchestrator — Phase 8: background agents with PR creation.
 *
 * A background run is fire-and-forget: `background/run` validates params,
 * persists a `queued` state, and returns `{ runId }` immediately. The run
 * itself executes as a detached async task inside the daemon (so it
 * survives the editor closing — it lives in the per-user sundayd, not in
 * any window):
 *
 *   queued → running (worktree on `sunday/bg/<id>`, agent loop with the
 *            FULL tool catalogue, cwd confined to the worktree)
 *          → committing → pr-creating → pr-created (branch pushed, GitHub
 *            PR opened — NEVER auto-merged; a human merges)
 *          → failed | cancelled (terminal)
 *
 * State is file-backed (`~/.sunday/background/<runId>.json`, atomic
 * writes), so `background/status` works across daemon restarts. Lifecycle
 * transitions stream as `background/event` notifications.
 *
 * Security: background agents run under the SAME sandbox/trust rules as
 * foreground agents (the daemon's PolicyGate + sandbox config apply to the
 * sub-agent's tool calls verbatim). The only privilege difference is
 * detachment. PR creation is the terminal action — there is no merge path.
 */

export interface BackgroundAgentHost extends OrchestratorHost {
  /** Emit `background/event` notifications to connected clients. */
  notifyBackground(event: BackgroundEvent): void;
}

/** Git + GitHub operations. Injected so tests can mock every side effect. */
export interface GitOps {
  /** True when the worktree has uncommitted changes. */
  hasChanges(cwd: string): Promise<boolean>;
  /** Stage everything and commit; resolves with the new SHA. */
  commitAll(cwd: string, message: string): Promise<string>;
  /** Push the branch to `origin`. */
  pushBranch(cwd: string, branch: string): Promise<void>;
  /** Open a GitHub PR; resolves with its URL and number. Never merges. */
  createPR(opts: {
    cwd: string;
    title: string;
    body: string;
    base: string;
    head: string;
  }): Promise<{ url: string; number: number }>;
}

export interface StartBackgroundRunOptions {
  goal: string;
  workspaceRoot: string;
  model?: string;
  baseBranch?: string;
  title?: string;
  signal?: AbortSignal;
  store?: FileBackgroundStateStore;
  /** Present in tests to avoid touching the real home dir. */
  now?: () => string;
}

/* ------------------------------------------------------------------ */
/* State store (file-backed, atomic writes — mirrors state.ts)         */
/* ------------------------------------------------------------------ */

function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId);
}

export function defaultBackgroundDir(): string {
  return path.join(os.homedir(), '.sunday', 'background');
}

export class FileBackgroundStateStore {
  constructor(private dir: string = defaultBackgroundDir()) {}

  get directory(): string {
    return this.dir;
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const files = await fsp.readdir(this.dir).catch(() => [] as string[]);
    for (const f of files) {
      if (f.endsWith('.tmp')) {
        await fsp.unlink(path.join(this.dir, f)).catch(() => undefined);
      }
    }
  }

  private fileFor(runId: string): string {
    if (!isSafeRunId(runId)) throw new BackgroundAgentError('invalid-run-id', `unsafe run id: ${runId}`);
    return path.join(this.dir, `${runId}.json`);
  }

  async save(state: BackgroundRunState): Promise<void> {
    const file = this.fileFor(state.runId);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  async load(runId: string): Promise<BackgroundRunState | undefined> {
    try {
      const raw = await fsp.readFile(this.fileFor(runId), 'utf8');
      return backgroundRunStateSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async list(): Promise<BackgroundRunState[]> {
    const files = await fsp.readdir(this.dir).catch(() => [] as string[]);
    const out: BackgroundRunState[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(this.dir, f), 'utf8');
        out.push(backgroundRunStateSchema.parse(JSON.parse(raw)));
      } catch {
        // Corrupt files are skipped — one bad file can't wedge the listing.
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

/* ------------------------------------------------------------------ */
/* In-memory registries (per daemon process)                           */
/* ------------------------------------------------------------------ */

const activeRuns = new Map<string, BackgroundRunState>();
const abortControllers = new Map<string, AbortController>();
let defaultStore: FileBackgroundStateStore | undefined;

export function getDefaultBackgroundStore(): FileBackgroundStateStore {
  if (!defaultStore) {
    defaultStore = new FileBackgroundStateStore();
    // Best-effort init; the detached task re-inits before first write.
    void defaultStore.init().catch(() => undefined);
  }
  return defaultStore;
}

export function getBackgroundRunState(runId: string): BackgroundRunState | undefined {
  return activeRuns.get(runId);
}

/* ------------------------------------------------------------------ */
/* Agent prompts                                                       */
/* ------------------------------------------------------------------ */

function slugify(goal: string): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'task'
  );
}

function backgroundSystemPrompt(): string {
  return [
    'You are SUNDAY, a background coding agent working detached from the user\'s editor.',
    'You work in an isolated git worktree (a dedicated branch). Your working directory',
    'is already the worktree root — never `cd` out of it, never touch files outside it.',
    '',
    'Rules:',
    '1. Implement the goal described in the user message. Keep changes focused and minimal.',
    '2. Run the project\'s tests for the files you touched when a test command is obvious',
    '   (package.json scripts, pytest, go test, etc.). Fix failures you introduced.',
    '3. Do NOT commit — the runner commits your changes when you finish.',
    '4. Do NOT push, open PRs, or merge — the runner handles publication.',
    '5. Do NOT run destructive commands (no `rm -rf /`, no force-pushes, no `git reset --hard`).',
    '6. When you are done, or when you cannot proceed, end your turn with a short summary',
    '   of what changed and how it was verified.',
  ].join('\n');
}

function backgroundUserPrompt(goal: string): string {
  return [
    '## Background task',
    '',
    goal,
    '',
    'Implement this in the current working directory (an isolated worktree).',
    'When finished, summarize the changes and verification in a few sentences.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Default GitOps (shell-backed)                                       */
/* ------------------------------------------------------------------ */

/** Escape a string for safe embedding in a POSIX shell double-quoted arg. */
function shq(s: string): string {
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

async function runGit(host: OrchestratorHost, cwd: string, args: string, signal?: AbortSignal): Promise<string> {
  const r = await host.tools.call('run_terminal', { command: `git ${args}` }, { cwd, signal });
  if (r.isError) throw new BackgroundAgentError('git-failed', `git ${args.split(' ')[0]} failed: ${r.output.slice(0, 500)}`);
  return r.output.trim();
}

/**
 * Shell-backed GitOps. `gh` is preferred for PR creation; when it is not
 * installed (or not authenticated) we fall back to the GitHub REST API
 * using `GITHUB_TOKEN`/`GH_TOKEN` from the daemon's environment. Both
 * paths only CREATE the PR — there is no merge call anywhere.
 */
export function createShellGitOps(host: OrchestratorHost, signal?: AbortSignal): GitOps {
  async function ghAvailable(cwd: string): Promise<boolean> {
    const r = await host.tools.call('run_terminal', { command: 'command -v gh' }, { cwd, signal });
    return !r.isError && r.output.trim().length > 0;
  }

  function parseRepoSlug(remoteUrl: string): { owner: string; repo: string } | undefined {
    const m = remoteUrl.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/);
    return m ? { owner: m[1], repo: m[2] } : undefined;
  }

  return {
    async hasChanges(cwd: string): Promise<boolean> {
      const out = await runGit(host, cwd, 'status --porcelain', signal);
      return out.length > 0;
    },

    async commitAll(cwd: string, message: string): Promise<string> {
      await runGit(host, cwd, 'add -A', signal);
      // --allow-empty keeps the pipeline total even for no-op runs.
      await runGit(host, cwd, `commit --allow-empty -m ${shq(message)}`, signal);
      return runGit(host, cwd, 'rev-parse HEAD', signal);
    },

    async pushBranch(cwd: string, branch: string): Promise<void> {
      await runGit(host, cwd, `push -u origin ${shq(branch)}`, signal);
    },

    async createPR({ cwd, title, body, base, head }): Promise<{ url: string; number: number }> {
      if (await ghAvailable(cwd)) {
        const r = await host.tools.call(
          'run_terminal',
          {
            command: `gh pr create --title ${shq(title)} --body ${shq(body)} --base ${shq(base)} --head ${shq(head)}`,
          },
          { cwd, signal },
        );
        if (r.isError) {
          throw new BackgroundAgentError('pr-failed', `gh pr create failed: ${r.output.slice(0, 500)}`);
        }
        const url = r.output.trim().split('\n').pop() ?? '';
        const num = Number(url.split('/').pop());
        if (!url.startsWith('http') || !Number.isInteger(num)) {
          throw new BackgroundAgentError('pr-failed', `could not parse PR url from gh output: ${url.slice(0, 200)}`);
        }
        return { url, number: num };
      }
      // REST fallback — needs a token and a github.com origin.
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      if (!token) {
        throw new BackgroundAgentError(
          'pr-failed',
          'gh CLI not found and no GITHUB_TOKEN/GH_TOKEN in the daemon environment; cannot create PR',
        );
      }
      const remote = await runGit(host, cwd, 'remote get-url origin', signal);
      const slug = parseRepoSlug(remote);
      if (!slug) {
        throw new BackgroundAgentError('pr-failed', `origin is not a github.com remote: ${remote.slice(0, 120)}`);
      }
      const res = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/pulls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, body, head, base }),
      });
      if (!res.ok) {
        throw new BackgroundAgentError('pr-failed', `GitHub API PR create failed: ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);
      }
      const data = (await res.json()) as { html_url?: string; number?: number };
      if (typeof data.html_url !== 'string' || typeof data.number !== 'number') {
        throw new BackgroundAgentError('pr-failed', 'GitHub API returned an unexpected PR payload');
      }
      return { url: data.html_url, number: data.number };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export async function startBackgroundRun(
  host: BackgroundAgentHost,
  opts: StartBackgroundRunOptions,
  gitOps?: GitOps,
): Promise<{ runId: string }> {
  const store = opts.store ?? getDefaultBackgroundStore();
  await store.init().catch(() => undefined);

  const runId = randomUUID();
  const now = opts.now ?? (() => new Date().toISOString());
  const title = opts.title?.trim() || slugify(opts.goal);
  const branch = `sunday/bg/${runId.slice(0, 8)}-${slugify(title)}`;
  const baseBranch = opts.baseBranch ?? 'HEAD';

  const state: BackgroundRunState = {
    runId,
    goal: opts.goal,
    workspaceRoot: opts.workspaceRoot,
    branch,
    baseBranch,
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
  };
  activeRuns.set(runId, state);
  await store.save(state);

  const controller = new AbortController();
  abortControllers.set(runId, controller);
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // Detached: the RPC returns while this continues in the daemon process.
  // Floating promise is intentional — all outcomes are persisted + notified.
  void executeBackgroundRun(host, gitOps ?? createShellGitOps(host, controller.signal), state, store, controller, now, opts.model).catch(
    (e) => {
      // Last-resort: never let an unhandled rejection kill the daemon.
      try {
        host.notifyBackground({ runId, phase: 'failed', detail: `runner crashed: ${(e as Error).message}` });
      } catch {
        /* notify is best-effort */
      }
    },
  );

  return { runId };
}

async function setStatus(
  host: BackgroundAgentHost,
  store: FileBackgroundStateStore,
  state: BackgroundRunState,
  status: BackgroundRunStatus,
  now: () => string,
  patch?: Partial<BackgroundRunState>,
  detail?: string,
): Promise<void> {
  Object.assign(state, patch, { status, updatedAt: now() });
  await store.save(state).catch(() => undefined);
  try {
    host.notifyBackground({ runId: state.runId, phase: status, detail });
  } catch {
    /* notify is best-effort */
  }
}

async function executeBackgroundRun(
  host: BackgroundAgentHost,
  gitOps: GitOps,
  state: BackgroundRunState,
  store: FileBackgroundStateStore,
  controller: AbortController,
  now: () => string,
  model?: string,
): Promise<void> {
  const signal = controller.signal;
  const { runId, workspaceRoot, branch, baseBranch, goal } = state;
  let worktreePath: string | undefined;

  const fail = async (error: string): Promise<void> => {
    abortControllers.delete(runId);
    await setStatus(host, store, state, 'failed', now, { error }, error);
  };

  try {
    await setStatus(host, store, state, 'running', now, undefined, 'worktree provisioning');

    // 1. Isolated worktree on a dedicated branch.
    const added = (await host.dispatch('worktree/add', {
      repoRoot: workspaceRoot,
      branch,
      // Branch from the requested base when it's a real ref, else HEAD.
      ...(baseBranch !== 'HEAD' ? { startPoint: baseBranch } : {}),
    })) as { path: string; branch: string };
    worktreePath = added.path;

    // Race guard: the run may have been cancelled between `background/run`
    // returning and the agent attaching its abort listener. Without this
    // check the abort is lost and the detached task hangs forever.
    if (signal.aborted) {
      await cancelCleanup();
      return;
    }

    // 2. Agent loop (FULL tool catalogue — same trust/sandbox rules as a
    //    foreground agent; the daemon's PolicyGate applies verbatim).
    const events: ChatEvent[] = [];
    await host.runSubAgent({
      title: `SUNDAY background: ${state.goal.slice(0, 80)}`,
      cwd: worktreePath,
      model,
      systemPrompt: backgroundSystemPrompt(),
      prompt: backgroundUserPrompt(goal),
      tools: host.tools,
      maxIterations: 60,
      signal,
      onEvent: (event) => {
        events.push(event);
      },
    });
    if (signal.aborted) {
      await cancelCleanup();
      return;
    }

    // 3. Commit whatever the agent changed.
    await setStatus(host, store, state, 'committing', now, undefined, 'committing worktree changes');
    const summary = summarizeEvents(events);
    const sha = await gitOps.commitAll(
      worktreePath,
      `Sunday background agent: ${state.goal.slice(0, 72)}\n\nRun: ${runId}\n${summary}`,
    );

    // 4. Push + open PR (never merge — human merges).
    await setStatus(host, store, state, 'pr-creating', now, undefined, `pushing ${branch}`);
    await gitOps.pushBranch(worktreePath, branch);
    const pr = await gitOps.createPR({
      cwd: worktreePath,
      title: `Sunday: ${state.goal.slice(0, 80)}`,
      body: [
        `Automated background run \`${runId}\`.`,
        '',
        '## Goal',
        '',
        goal,
        '',
        '## Agent summary',
        '',
        summary,
        '',
        `Commit: \`${sha}\``,
        '',
        '_Created by the Sunday background agent. A human must review and merge._',
      ].join('\n'),
      base: baseBranch === 'HEAD' ? await defaultBranch(host, worktreePath, signal) : baseBranch,
      head: branch,
    });

    abortControllers.delete(runId);
    await setStatus(
      host,
      store,
      state,
      'pr-created',
      now,
      { prUrl: pr.url, prNumber: pr.number },
      `PR #${pr.number} opened: ${pr.url}`,
    );
  } catch (e) {
    if (signal.aborted || (e as Error).name === 'AbortError') {
      await cancelCleanup();
      return;
    }
    await fail((e as Error).message ?? String(e));
  }

  async function cancelCleanup(): Promise<void> {
    abortControllers.delete(runId);
    if (worktreePath) {
      await (host.dispatch('worktree/remove', { repoRoot: workspaceRoot, path: worktreePath, force: true }).catch(() => undefined));
    }
    await setStatus(host, store, state, 'cancelled', now, undefined, 'run cancelled');
  }
}

async function defaultBranch(host: OrchestratorHost, cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    const r = await host.tools.call('run_terminal', { command: 'git remote show origin | sed -n "s/.*HEAD branch: //p"' }, { cwd, signal });
    const b = r.output.trim().split('\n')[0]?.trim();
    if (b) return b;
  } catch {
    /* fall through */
  }
  return 'main';
}

function summarizeEvents(events: ChatEvent[]): string {
  const texts: string[] = [];
  for (const e of events) {
    const t = (e as { textDelta?: string; text?: string }).textDelta ?? (e as { text?: string }).text;
    if (typeof t === 'string' && t.trim()) texts.push(t);
    if (texts.join('').length > 1200) break;
  }
  const tail = texts.join('').slice(-1200).trim();
  return tail || '(agent produced no summary)';
}

export async function cancelBackgroundRun(
  host: BackgroundAgentHost,
  runId: string,
  store?: FileBackgroundStateStore,
): Promise<{ cancelled: boolean }> {
  const s = store ?? getDefaultBackgroundStore();
  const state = activeRuns.get(runId) ?? (await s.load(runId));
  if (!state) throw new BackgroundAgentError('unknown-run', `no such background run: ${runId}`);
  const terminal = (['pr-created', 'failed', 'cancelled'] as readonly string[]).includes(state.status);
  if (terminal) return { cancelled: false };
  const controller = abortControllers.get(runId);
  if (controller) {
    controller.abort();
    return { cancelled: true };
  }
  // Queued but not yet executing (or daemon restarted): mark cancelled directly.
  activeRuns.set(runId, state);
  await s.init().catch(() => undefined);
  Object.assign(state, { status: 'cancelled' as BackgroundRunStatus, updatedAt: new Date().toISOString() });
  await s.save(state);
  try {
    host.notifyBackground({ runId, phase: 'cancelled', detail: 'run cancelled' });
  } catch {
    /* best-effort */
  }
  return { cancelled: true };
}

export async function getBackgroundStatus(runId: string, store?: FileBackgroundStateStore): Promise<BackgroundRunState> {
  const live = activeRuns.get(runId);
  if (live) return live;
  const s = store ?? getDefaultBackgroundStore();
  const persisted = await s.load(runId);
  if (!persisted) throw new BackgroundAgentError('unknown-run', `no such background run: ${runId}`);
  return persisted;
}

/**
 * Mark non-terminal runs as failed after a daemon restart (their in-memory
 * AbortControllers are gone, so they can never complete). Called once at
 * daemon startup; best-effort.
 */
export async function reconcileBackgroundRuns(
  notify: (event: BackgroundEvent) => void,
  store?: FileBackgroundStateStore,
): Promise<number> {
  const s = store ?? getDefaultBackgroundStore();
  await s.init().catch(() => undefined);
  const runs = await s.list();
  let n = 0;
  for (const r of runs) {
    if ((['pr-created', 'failed', 'cancelled'] as readonly string[]).includes(r.status)) continue;
    r.status = 'failed';
    r.error = 'daemon restarted while the run was in flight';
    r.updatedAt = new Date().toISOString();
    await s.save(r).catch(() => undefined);
    try {
      notify({ runId: r.runId, phase: 'failed', detail: r.error });
    } catch {
      /* best-effort */
    }
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* RPC handlers                                                        */
/* ------------------------------------------------------------------ */

export function createBackgroundHandlers(
  host: BackgroundAgentHost,
  gitOps?: GitOps,
): Record<BackgroundMethodName, OrchestrationMethodHandler> {
  return {
    'background/run': async (params: unknown) => {
      const def = BACKGROUND_METHODS['background/run'];
      const p = def.params.safeParse(params);
      if (!p.success) {
        throw new BackgroundAgentError(
          'invalid-params',
          `background/run: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      // Fire-and-forget: the RPC resolves with { runId } while the detached
      // task continues inside the daemon.
      const result = await startBackgroundRun(host, { ...p.data }, gitOps);
      return def.result.parse(result);
    },
    'background/status': async (params: unknown) => {
      const def = BACKGROUND_METHODS['background/status'];
      const p = def.params.safeParse(params);
      if (!p.success) {
        throw new BackgroundAgentError(
          'invalid-params',
          `background/status: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      return def.result.parse(await getBackgroundStatus(p.data.runId));
    },
    'background/cancel': async (params: unknown) => {
      const def = BACKGROUND_METHODS['background/cancel'];
      const p = def.params.safeParse(params);
      if (!p.success) {
        throw new BackgroundAgentError(
          'invalid-params',
          `background/cancel: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      return def.result.parse(await cancelBackgroundRun(host, p.data.runId));
    },
  };
}

/**
 * Structural interface the daemon must satisfy. The parent wires the real
 * daemon to this (see cli.ts) — this package never imports @sunday/sundayd.
 */
export interface BackgroundCapableDaemon {
  addMethod(name: string, handler: OrchestrationMethodHandler): void;
  getBackgroundHost(): BackgroundAgentHost;
}

export function registerBackgroundMethods(daemon: BackgroundCapableDaemon, gitOps?: GitOps): void {
  const handlers = createBackgroundHandlers(daemon.getBackgroundHost(), gitOps);
  for (const [name, handler] of Object.entries(handlers)) {
    daemon.addMethod(name, handler);
  }
}
