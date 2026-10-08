// sunday-agent — cloud async tasks (Group A, A1).
//
// Commands to submit a prompt to the hosted gateway's agent-task queue and
// to list/poll your tasks. The daemon-side CloudTaskRunner (sundayd) claims
// and executes queued tasks when `sunday.cloudTasks.enabled` is true; the
// IDE side polls every 30s and shows a VS Code notification on completion.
//
// vscode-coupled by design; covered by cloudTasks.test.ts with a mocked
// `vscode` module and an injected fetch.
import * as vscode from 'vscode';

export const CLOUD_TASK_SUBMIT_COMMAND = 'sunday.cloudTask.submit';
export const CLOUD_TASK_LIST_COMMAND = 'sunday.cloudTask.list';

/** Config keys (sunday.* namespace). */
export const CLOUD_TASKS_ENABLED_CONFIG = 'cloudTasks.enabled';
export const CLOUD_TASKS_GATEWAY_URL_CONFIG = 'cloudTasks.gatewayUrl';

export const DEFAULT_GATEWAY_URL = 'https://sunday-final-ide.onrender.com';
export const CLOUD_TASK_POLL_MS = 30_000;

export interface CloudTask {
  id: string;
  prompt: string;
  repo_context?: string;
  status: 'queued' | 'claimed' | 'completed' | 'failed';
  created_at: string;
  claimed_at?: string;
  completed_at?: string;
  result?: string;
  error?: string;
}

function gatewayUrl(): string {
  const raw = vscode.workspace
    .getConfiguration('sunday')
    .get<string>(CLOUD_TASKS_GATEWAY_URL_CONFIG, '')
    .trim()
    .replace(/\/$/, '');
  return raw || process.env.SUNDAY_API_URL?.trim().replace(/\/$/, '') || DEFAULT_GATEWAY_URL;
}

/**
 * Silent sign-in token for the gateway, mirroring the activate() hosted
 * configuration: try the IDE's auth sessions without ever prompting. The
 * token belongs in the Authorization header, never in logs.
 */
export async function resolveCloudTaskToken(): Promise<string | undefined> {
  const candidates: Array<{ provider: string; scopes: string[] }> = [
    { provider: 'github', scopes: ['read:user'] },
    { provider: 'microsoft', scopes: ['User.Read'] },
    { provider: 'google', scopes: ['openid', 'email', 'profile'] },
  ];
  for (const c of candidates) {
    try {
      const session = await vscode.authentication.getSession(c.provider, c.scopes, {
        createIfNone: false,
        silent: true,
      });
      if (session?.accessToken) return session.accessToken;
    } catch {
      // Provider unavailable — try the next.
    }
  }
  return undefined;
}

/** Thin HTTP client for the gateway /agent/tasks API (fetch injectable). */
export class CloudTaskClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => Promise<string | undefined>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const token = await this.getToken();
    if (!token) {
      throw new Error('Not signed in. Sign in with GitHub, Microsoft, or Google in the IDE to use cloud tasks.');
    }
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`gateway ${res.status}: ${snippet}`);
    }
    return res.json() as Promise<unknown>;
  }

  async submit(prompt: string, repoContext?: string): Promise<CloudTask> {
    const data = (await this.request('/agent/tasks', {
      method: 'POST',
      body: { prompt, ...(repoContext ? { repo_context: repoContext } : {}) },
    })) as { task: CloudTask };
    return data.task;
  }

  async list(): Promise<CloudTask[]> {
    const data = (await this.request('/agent/tasks')) as { tasks: CloudTask[] };
    return Array.isArray(data.tasks) ? data.tasks : [];
  }

  async get(id: string): Promise<CloudTask> {
    const data = (await this.request(`/agent/tasks/${encodeURIComponent(id)}`)) as { task: CloudTask };
    return data.task;
  }
}

export interface CloudTaskCommandDeps {
  makeClient: () => CloudTaskClient;
  log: (msg: string) => void;
}

function taskSummary(t: CloudTask): string {
  const when = t.created_at ? new Date(t.created_at).toLocaleString() : '';
  return `${t.status.toUpperCase()} · ${t.prompt.slice(0, 80)}${when ? ` · ${when}` : ''}`;
}

export async function submitCloudTask(deps: CloudTaskCommandDeps): Promise<void> {
  const prompt = await vscode.window.showInputBox({
    title: 'Sunday: Submit cloud task',
    prompt: 'Prompt for the background agent (runs on your daemon via the gateway queue)',
    placeHolder: 'e.g. Refactor the auth module to use the new session API',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a prompt.'),
  });
  if (!prompt) return; // dismissed
  const repoContext = await vscode.window.showInputBox({
    title: 'Sunday: Submit cloud task',
    prompt: 'Optional repo context (free text hint for the agent)',
    placeHolder: 'e.g. repo: Sunday, branch main',
  });
  try {
    const task = await deps.makeClient().submit(prompt.trim(), repoContext?.trim() || undefined);
    deps.log(`cloud task submitted: ${task.id}`);
    vscode.window.showInformationMessage(
      `Cloud task queued (${task.id}). Your daemon will pick it up when cloud tasks are enabled.`,
    );
  } catch (err) {
    deps.log(`cloud task submit failed: ${(err as Error).message}`);
    vscode.window.showErrorMessage(`Cloud task submit failed: ${(err as Error).message}`);
  }
}

export async function listCloudTasks(deps: CloudTaskCommandDeps): Promise<void> {
  let tasks: CloudTask[];
  try {
    tasks = await deps.makeClient().list();
  } catch (err) {
    vscode.window.showErrorMessage(`Could not list cloud tasks: ${(err as Error).message}`);
    return;
  }
  if (!tasks.length) {
    vscode.window.showInformationMessage('No cloud tasks yet. Submit one with "Sunday: Submit Cloud Task".');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    tasks.map((t) => ({ label: t.id, description: taskSummary(t), task: t })),
    { title: 'Sunday: Cloud tasks', placeHolder: 'Select a task to view its result' },
  );
  if (!pick) return;
  const t = pick.task;
  const detail = t.status === 'completed'
    ? `Result:\n${t.result ?? '(empty)'}`
    : t.status === 'failed'
      ? `Failed: ${t.error ?? '(no error detail)'}`
      : `Status: ${t.status}. The daemon picks up queued tasks when sunday.cloudTasks.enabled is on.`;
  vscode.window.showInformationMessage(`${t.id} — ${t.prompt.slice(0, 120)}\n\n${detail.slice(0, 1500)}`);
}

export interface CloudTaskPollDeps extends CloudTaskCommandDeps {
  isEnabled: () => boolean;
}

/**
 * Poll the gateway every 30s; notify when a task transitions to a terminal
 * state. Returns a disposable that stops the loop. Silent when disabled or
 * signed out (local-first: no polling, no errors).
 */
export function startCloudTaskPolling(
  context: vscode.ExtensionContext,
  deps: CloudTaskPollDeps,
  intervalMs = CLOUD_TASK_POLL_MS,
): vscode.Disposable {
  const seen = new Map<string, string>(); // task id → last known status
  let stopped = false;
  const poll = async (): Promise<void> => {
    if (stopped || !deps.isEnabled()) return;
    let tasks: CloudTask[];
    try {
      tasks = await deps.makeClient().list();
    } catch {
      return; // gateway unreachable or signed out — stay silent, retry later
    }
    for (const t of tasks) {
      const prev = seen.get(t.id);
      seen.set(t.id, t.status);
      if (prev === undefined) continue; // first sighting — baseline, no notify
      if (prev !== t.status && (t.status === 'completed' || t.status === 'failed')) {
        const msg =
          t.status === 'completed'
            ? `Cloud task ${t.id} completed.`
            : `Cloud task ${t.id} failed: ${(t.error ?? 'no detail').slice(0, 200)}`;
        deps.log(`cloud task ${t.id} → ${t.status}`);
        vscode.window.showInformationMessage(msg, 'View').then((choice) => {
          if (choice === 'View') void listCloudTasks(deps);
        });
      }
    }
  };
  const timer = setInterval(() => void poll(), intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  // Prime the baseline without notifying.
  void poll();
  return {
    dispose: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function registerCloudTaskCommands(
  context: vscode.ExtensionContext,
  deps: CloudTaskCommandDeps & Partial<CloudTaskPollDeps>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CLOUD_TASK_SUBMIT_COMMAND, () => submitCloudTask(deps)),
    vscode.commands.registerCommand(CLOUD_TASK_LIST_COMMAND, () => listCloudTasks(deps)),
  );
  if (deps.isEnabled) {
    context.subscriptions.push(startCloudTaskPolling(context, deps as CloudTaskPollDeps));
  }
}

/** Default production wiring (extension.ts). */
export function defaultCloudTaskDeps(log: (msg: string) => void): CloudTaskCommandDeps & CloudTaskPollDeps {
  return {
    makeClient: () => new CloudTaskClient(gatewayUrl(), resolveCloudTaskToken),
    isEnabled: () =>
      vscode.workspace.getConfiguration('sunday').get<boolean>(CLOUD_TASKS_ENABLED_CONFIG, false),
    log,
  };
}
