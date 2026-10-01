// @sunday/eval — model adapters.
//
// FakeModelAdapter replays a task's scripted steps through the REAL tool
// registry, so the harness measures tool-call reliability with no API keys.
// SundaydAdapter drives a live model through sundayd over stdio JSON-RPC —
// used for real benchmark runs when provider keys are configured.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createDefaultRegistry } from '@sunday/tools';
import type { EvalTask, ExecutedCall, ModelAdapter, ScriptStep } from './types.js';

/** Execute scripted steps against the real tools; record every call. */
export class FakeModelAdapter implements ModelAdapter {
  readonly name = 'fake-scripted';

  async runTask(task: EvalTask, workspaceRoot: string): Promise<ExecutedCall[]> {
    const registry = createDefaultRegistry();
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

export type { ScriptStep };
