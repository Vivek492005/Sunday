// @sunday/eval — model adapters.
//
// FakeModelAdapter replays a task's scripted steps through the REAL tool
// registry, so the harness measures tool-call reliability with no API keys.
// SundaydAdapter drives a live model through sundayd over stdio JSON-RPC —
// used for real benchmark runs when provider keys are configured.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@sunday/protocol';
import { createDefaultRegistry, type Tool, type ToolContext } from '@sunday/tools';
import type { BaselineUsage, EvalTask, ExecutedCall, ModelAdapter, ScriptStep } from './types.js';

/** Token usage harvested from `usage` chat events during one task. */
export type { BaselineUsage };

/** Env vars accepted as provider credentials for a live baseline run. */
export const BASELINE_KEY_ENV_VARS = ['OPENROUTER_API_KEY', 'GROQ_API_KEY'] as const;

/**
 * Returns the names of provider-key env vars that are set and non-blank.
 * Names only — values are never read or logged by the baseline harness.
 */
export function detectProviderKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return BASELINE_KEY_ENV_VARS.filter((k) => (env[k] ?? '').trim().length > 0);
}

/**
 * Eval-local stub browser tools (browser eval exit criteria).
 *
 * The harness runs in CI and on this VM with no real Chromium, so scripted
 * `browser_*` calls are replayed against these deterministic stubs instead of
 * browserd. They return canned, well-formed results; each task's checker
 * asserts the real workspace side effects (the fixed file, the written
 * walkthrough doc). Registration is additive — it never changes the results
 * of tasks whose scripts never call these tools.
 */
function browserStubTools(): Tool[] {
  const browserOpen: Tool = {
    definition: {
      name: 'browser_open',
      description: 'Open a URL in the agent browser (eval stub — no real navigation).',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string' }, approve: { type: 'boolean' } },
      },
    },
    async execute(args) {
      return { output: `opened ${String(args.url)} (eval stub — no real navigation)` };
    },
  };
  const browserSnapshot: Tool = {
    definition: {
      name: 'browser_snapshot',
      description: 'Accessibility snapshot of the current page (eval stub).',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return {
        output: [
          'snapshot (eval stub):',
          '- heading "Welcom to Sunday" [e0]',
          '- button "Buy now" [e1]',
        ].join('\n'),
      };
    },
  };
  const browserConsole: Tool = {
    definition: {
      name: 'browser_console',
      description: 'Console entries for the current page (eval stub).',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return { output: 'console (eval stub): no entries' };
    },
  };
  const browserVerifyUi: Tool = {
    definition: {
      name: 'browser_verify_ui',
      description: 'Run UI checks against the current page (eval stub — canned pass).',
      parameters: {
        type: 'object',
        required: ['checks'],
        properties: {
          url: { type: 'string' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              required: ['kind'],
              properties: { kind: { type: 'string' }, text: { type: 'string' }, ref: { type: 'string' } },
            },
          },
        },
      },
    },
    async execute(args) {
      const checks = (args.checks as Array<{ kind?: string }>) ?? [];
      const kinds = checks.map((c) => c.kind).join(', ');
      return {
        output: `verify_ui (eval stub): ${checks.length}/${checks.length} checks passed [${kinds}]`,
        metadata: { ok: true },
      };
    },
  };
  const browserWalkthrough: Tool = {
    definition: {
      name: 'browser_walkthrough',
      description:
        'Record a narrated browser walkthrough (eval stub: writes .sunday/artifacts/walkthrough.md, no real screenshots).',
      parameters: {
        type: 'object',
        required: ['steps'],
        properties: {
          title: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['narration'],
              properties: { narration: { type: 'string' }, screenshot: { type: 'boolean' } },
            },
          },
        },
      },
    },
    async execute(args, ctx: ToolContext) {
      const steps = (args.steps as Array<{ narration?: string; screenshot?: boolean }>) ?? [];
      const dir = join(ctx.cwd, '.sunday', 'artifacts');
      mkdirSync(dir, { recursive: true });
      const lines = [`# ${String(args.title ?? 'Browser walkthrough')}`, ''];
      steps.forEach((s, i) => {
        lines.push(`## Step ${i + 1}`, '', String(s.narration ?? ''), '');
        lines.push(`_(screenshot: ${s.screenshot ? 'captured' : 'skipped'} — eval stub)_`, '');
      });
      const rel = join('.sunday', 'artifacts', 'walkthrough.md');
      writeFileSync(join(ctx.cwd, rel), lines.join('\n'));
      return {
        output: `walkthrough written to ${rel} (${steps.length} steps)`,
        metadata: { path: rel },
      };
    },
  };
  return [browserOpen, browserSnapshot, browserConsole, browserVerifyUi, browserWalkthrough];
}

/** Execute scripted steps against the real tools; record every call. */
export class FakeModelAdapter implements ModelAdapter {
  readonly name = 'fake-scripted';

  async runTask(task: EvalTask, workspaceRoot: string): Promise<ExecutedCall[]> {
    const registry = createDefaultRegistry();
    // Browser tasks run against the deterministic stubs (no Chromium in CI).
    for (const t of browserStubTools()) registry.register(t);
    const transcript: ExecutedCall[] = [];
    for (const step of task.script) {
      if (step.kind === 'answer') continue;
      const started = Date.now();
      const result = await registry.call(step.tool, step.args, { cwd: workspaceRoot });
      transcript.push({
        tool: step.tool,
        args: step.args,
        valid: !result.isError,
        result,
        durationMs: Date.now() - started,
      });
    }
    return transcript;
  }
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ChatEvent {
  jsonrpc: '2.0';
  method: 'chat/event';
  params: { type: string; [k: string]: unknown };
}

/**
 * Live adapter: spawns `node <sundayd-cli>` and runs one chat turn per task,
 * harvesting tool calls from chat/event notifications. Requires provider
 * credentials in the environment (same as a normal sundayd run).
 */
export class SundaydAdapter implements ModelAdapter {
  readonly name = 'sundayd-live';
  constructor(private readonly cliPath: string) {}

  async runTask(task: EvalTask, workspaceRoot: string): Promise<ExecutedCall[]> {
    const proc = spawn('node', [this.cliPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    const calls: ExecutedCall[] = [];
    try {
      const send = (id: number, method: string, params: unknown): void => {
        proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      };
      const pending = new Map<number, (r: RpcResponse) => void>();
      const rl = createInterface({ input: proc.stdout! });
      const turnDone = new Promise<void>((resolve) => {
        rl.on('line', (line) => {
          let msg: RpcResponse | ChatEvent;
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          if ('id' in msg && typeof msg.id === 'number') {
            pending.get(msg.id)?.(msg as RpcResponse);
            pending.delete(msg.id);
            return;
          }
          const ev = msg as ChatEvent;
          if (ev.method === 'chat/event') {
            const p = ev.params;
            if (p.type === 'tool-call') {
              calls.push({
                tool: String(p.tool ?? p.name ?? 'unknown'),
                args: (p.args ?? {}) as Record<string, unknown>,
                valid: true,
                result: { output: String(p.output ?? '') },
                durationMs: 0,
              });
            } else if (p.type === 'turn-end' || p.type === 'turn-error') {
              resolve();
            }
          }
        });
      });
      const rpc = (method: string, params: unknown): Promise<unknown> =>
        new Promise((resolve, reject) => {
          const id = Math.floor(Math.random() * 1e9);
          const timer = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 120_000);
          pending.set(id, (r) => {
            clearTimeout(timer);
            if (r.error) reject(new Error(r.error.message));
            else resolve(r.result);
          });
          send(id, method, params);
        });

      await rpc('sunday/hello', { version: '0.1.0' });
      const session = (await rpc('session/create', { workspaceRoot })) as { sessionId: string };
      await rpc('chat/send', { sessionId: session.sessionId, message: task.prompt });
      await turnDone;
      return calls;
    } finally {
      proc.kill('SIGTERM');
    }
  }
}

export function isLiveRequested(): boolean {
  return process.env.SUNDAY_EVAL_LIVE === '1';
}

/**
 * Live baseline adapter: drives a REAL provider model through sundayd over
 * stdio JSON-RPC using the current wire protocol, and harvests token usage.
 *
 * Wire-format notes (this is what `SundaydAdapter` above predates):
 * - `sunday/hello` requires `{ protocolVersion, client: { name, version, os } }`.
 * - `session/create` returns `{ session: { id, ... } }` (not a bare sessionId).
 * - `chat/send` returns `{ turnId }` immediately; the turn streams as
 *   `chat/event` notifications whose params are `{ turnId, sessionId, event }`
 *   — the event payload is NESTED under `event`, not flat on params.
 * - `tool-result` events carry `{ toolCallId, isError, content }`; a call
 *   whose result has `isError: true` is marked invalid in the transcript.
 * - `usage` events carry `{ inputTokens, outputTokens }` and are accumulated
 *   per task.
 *
 * A per-task timeout guards against hung turns (default 10 min, override via
 * `taskTimeoutMs`); the daemon child is always SIGTERM'd afterwards.
 */
export class LiveBaselineAdapter implements ModelAdapter {
  readonly name = 'sundayd-live-baseline';
  private readonly taskTimeoutMs: number;
  private readonly model?: string;

  constructor(
    private readonly cliPath: string,
    opts: { taskTimeoutMs?: number; model?: string } = {},
  ) {
    this.taskTimeoutMs = opts.taskTimeoutMs ?? 600_000;
    this.model = opts.model;
  }

  async runTask(task: EvalTask, workspaceRoot: string): Promise<ExecutedCall[]> {
    return (await this.runTaskDetailed(task, workspaceRoot)).transcript;
  }

  async runTaskDetailed(
    task: EvalTask,
    workspaceRoot: string,
  ): Promise<{ transcript: ExecutedCall[]; usage: BaselineUsage }> {
    const proc = spawn('node', [this.cliPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    const transcript: ExecutedCall[] = [];
    const usage: BaselineUsage = { inputTokens: 0, outputTokens: 0 };
    const callsById = new Map<string, ExecutedCall>();
    let turnFailure: string | null = null;
    try {
      const send = (id: number, method: string, params: unknown): void => {
        proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      };
      const pending = new Map<number, (r: RpcResponse) => void>();
      const rl = createInterface({ input: proc.stdout! });
      const turnDone = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          turnFailure = `task timeout after ${this.taskTimeoutMs}ms`;
          resolve();
        }, this.taskTimeoutMs);
        // Don't let a hung turn keep the process alive after the timeout.
        timer.unref?.();
        rl.on('line', (line) => {
          let msg: {
            id?: unknown;
            method?: unknown;
            params?: { event?: { type?: unknown; call?: unknown; result?: unknown; usage?: unknown; finishReason?: unknown; code?: unknown; message?: unknown } };
          };
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          if (msg && typeof msg.id === 'number') {
            pending.get(msg.id)?.(msg as RpcResponse);
            pending.delete(msg.id);
            return;
          }
          if (msg?.method !== 'chat/event') return;
          const event = msg?.params?.event;
          if (!event || typeof event.type !== 'string') return;
          switch (event.type) {
            case 'tool-call': {
              const call = (event.call ?? {}) as { id?: unknown; name?: unknown; arguments?: unknown };
              const entry: ExecutedCall = {
                tool: String(call.name ?? 'unknown'),
                args: (call.arguments ?? {}) as Record<string, unknown>,
                valid: true,
                result: { output: '' },
                durationMs: 0,
              };
              if (call.id != null) callsById.set(String(call.id), entry);
              transcript.push(entry);
              break;
            }
            case 'tool-result': {
              const r = (event.result ?? {}) as {
                toolCallId?: unknown;
                isError?: unknown;
                content?: unknown;
              };
              const entry = r.toolCallId != null ? callsById.get(String(r.toolCallId)) : undefined;
              if (entry) {
                if (Array.isArray(r.content)) {
                  const text = r.content
                    .filter((c) => (c as { type?: unknown })?.type === 'text')
                    .map((c) => String((c as { text?: unknown })?.text ?? ''))
                    .join('\n');
                  if (text) entry.result = { output: text };
                }
                if (r.isError === true) entry.valid = false;
              }
              break;
            }
            case 'usage': {
              const u = (event.usage ?? {}) as { inputTokens?: unknown; outputTokens?: unknown };
              usage.inputTokens += Math.max(0, Math.floor(Number(u.inputTokens ?? 0) || 0));
              usage.outputTokens += Math.max(0, Math.floor(Number(u.outputTokens ?? 0) || 0));
              break;
            }
            case 'turn-end':
              clearTimeout(timer);
              if (event.finishReason != null && event.finishReason !== 'stop') {
                turnFailure = `turn ended with finishReason=${String(event.finishReason)}`;
              }
              resolve();
              break;
            case 'turn-error':
              clearTimeout(timer);
              turnFailure = `turn-error ${String(event.code ?? '')}: ${String(event.message ?? 'unknown')}`.trim();
              resolve();
              break;
          }
        });
      });
      const rpc = (method: string, params: unknown): Promise<unknown> =>
        new Promise((resolve, reject) => {
          const id = Math.floor(Math.random() * 1e9);
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`rpc timeout: ${method}`));
          }, 120_000);
          timer.unref?.();
          pending.set(id, (r) => {
            clearTimeout(timer);
            if (r.error) reject(new Error(r.error.message));
            else resolve(r.result);
          });
          send(id, method, params);
        });

      await rpc('sunday/hello', {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: 'sunday-eval-baseline', version: '0.1.0', os: process.platform },
      });
      const created = (await rpc('session/create', { cwd: workspaceRoot })) as {
        session?: { id?: unknown };
      };
      const sessionId = created?.session?.id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('session/create returned no session id');
      }
      await rpc('chat/send', {
        sessionId,
        message: task.prompt,
        ...(this.model ? { model: this.model } : {}),
      });
      await turnDone;
      if (turnFailure) throw new Error(turnFailure);
      return { transcript, usage };
    } finally {
      proc.kill('SIGTERM');
    }
  }
}

export type { ScriptStep };
