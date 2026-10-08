/**
 * @sunday/sundayd — Cloud async task runner (Group A, A1).
 *
 * Polls the hosted gateway for queued agent tasks created from another IDE
 * (or the `sunday.cloudTask.submit` command) and executes them through the
 * local agent pipeline in the background. Runs only when
 * `sunday.cloudTasks.enabled` is true (default: false) and a gateway
 * credential is available. Any failure — gateway unreachable, bad token,
 * execution error — is logged and swallowed: the daemon must never crash
 * because a background poll failed.
 */

export interface RemoteCloudTask {
  id: string;
  prompt: string;
  repo_context?: string;
  status: string;
  result?: string;
  error?: string;
}

export interface CloudTaskRunnerOptions {
  /** Base URL of the hosted gateway, e.g. https://sunday-final-ide.onrender.com */
  gatewayUrl: string;
  /** Bearer credential (Sunday session token / API key); undefined = signed out. */
  authToken: () => string | undefined;
  /** Config gate (`sunday.cloudTasks.enabled`, default false). */
  enabled: () => boolean;
  /** Execute one prompt through the agent pipeline; resolves with result text. */
  execute: (prompt: string) => Promise<string>;
  pollIntervalMs?: number;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
  /** Emitted after a task reaches a terminal state (drives IDE notifications). */
  onTaskFinished?: (task: RemoteCloudTask) => void;
}

const DEFAULT_POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

export class CloudTaskRunner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(private readonly opts: CloudTaskRunnerOptions) {}

  /** Start the background poll loop (no-op when disabled). */
  start(): void {
    this.stop();
    const interval = this.opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.timer = setInterval(() => {
      void this.pollOnce().catch((e) => this.log(`poll loop error: ${(e as Error).message}`));
    }, interval);
    // Never keep the daemon alive just for polling.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll cycle; public so tests can drive it without timers. */
  async pollOnce(): Promise<void> {
    if (this.polling) return; // never overlap polls
    if (!this.opts.enabled()) return;
    const token = this.opts.authToken();
    if (!token) return; // signed out — stay silent
    this.polling = true;
    try {
      const tasks = await this.listQueued(token);
      for (const t of tasks) {
        const claimed = await this.claim(token, t.id);
        if (!claimed) continue; // someone else got it, or it vanished
        let result: string | undefined;
        let error: string | undefined;
        try {
          result = await this.opts.execute(t.prompt);
        } catch (e) {
          error = `execution failed: ${(e as Error).message}`.slice(0, 4000);
        }
        try {
          await this.postResult(token, t.id, result, error);
        } catch (e) {
          this.log(`failed to post result for ${t.id}: ${(e as Error).message}`);
          continue;
        }
        this.opts.onTaskFinished?.({ ...t, status: error ? 'failed' : 'completed', result, error });
      }
    } catch (e) {
      // Gateway unreachable / bad token / malformed response: log, retry next cycle.
      this.log(`cloud task poll failed: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private log(msg: string): void {
    this.opts.log?.(`[cloud-tasks] ${msg}`);
  }

  private async api(
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${this.opts.gatewayUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const snippet = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`gateway ${res.status}: ${snippet}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async listQueued(token: string): Promise<RemoteCloudTask[]> {
    const data = (await this.api(token, '/agent/tasks')) as { tasks?: RemoteCloudTask[] };
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    return tasks.filter((t) => t && t.status === 'queued' && typeof t.id === 'string');
  }

  private async claim(token: string, id: string): Promise<boolean> {
    try {
      await this.api(token, `/agent/tasks/${encodeURIComponent(id)}/claim`, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
  }

  private async postResult(
    token: string,
    id: string,
    result: string | undefined,
    error: string | undefined,
  ): Promise<void> {
    await this.api(token, `/agent/tasks/${encodeURIComponent(id)}/result`, {
      method: 'POST',
      body: error ? { error } : { result: result ?? '(no output)' },
    });
  }
}
