/**
 * Extension-host manager — spawns the host with --sunday-extension-host
 * (same safe pattern as daemonClient: never launch the binary without a
 * mode flag) and speaks JSON-RPC over stdio.
 *
 * Safety: circuit breaker (max 3 spawns/60s), 100-cap on pending RPCs,
 * 30s per-RPC timeout. One crashing host never kills the IDE.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

let hostProc: ChildProcess | null = null;
let hostReady: Promise<void> | null = null;
let rpcId = 1;
const pending = new Map<number | string, PendingRpc>();
let spawnAttempts: number[] = [];
let stdinBuffer = '';

function hostBin(): string {
  return path.resolve(__dirname, 'exthost.cjs');
}

function spawnAllowed(): boolean {
  const now = Date.now();
  spawnAttempts = spawnAttempts.filter((t) => now - t < 60_000);
  return spawnAttempts.length < 3;
}

function onHostData(chunk: Buffer): void {
  stdinBuffer += chunk.toString('utf-8');
  let idx: number;
  while ((idx = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, idx).trim();
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (!line) continue;
    let msg: {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      continue;
    }
    if (msg.method) {
      // Bridge calls from the host (vscode window.* / env.*) → resolve with a
      // neutral value; the IDE main handlers below fulfill real ones.
      void handleBridgeCall(msg.method, msg.params ?? {}).then(
        (r) => {
          if (msg.id !== undefined && hostProc?.stdin)
            hostProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: r }) + '\n');
        },
        (e: Error) => {
          if (msg.id !== undefined && hostProc?.stdin)
            hostProc.stdin.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: e.message } }) + '\n',
            );
        },
      );
    }
  }
}

// Bridge handlers for vscode API calls that need the real IDE.
// `notify` is set by main.ts (window messages, input boxes, etc.).
let notify: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | null = null;
export function setExtensionHostNotifier(
  fn: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): void {
  notify = fn;
}

async function handleBridgeCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (notify) {
    try {
      return await notify(method, params);
    } catch {
      return null;
    }
  }
  // No notifier yet — neutral answers so extensions don't hang.
  if (method === 'window.showInputBox') return undefined;
  if (method === 'window.showQuickPick') return undefined;
  return null;
}

export function ensureExtensionHost(): Promise<void> {
  if (hostReady) return hostReady;
  if (!spawnAllowed()) {
    return Promise.reject(
      new Error('extension host failed to start repeatedly — circuit breaker engaged. Restart Sunday to retry.'),
    );
  }
  spawnAttempts.push(Date.now());
  hostReady = new Promise<void>((resolve, reject) => {
    const bin = hostBin();
    if (!fs.existsSync(bin)) {
      reject(new Error(`extension host not built at ${bin}`));
      return;
    }
    const proc = spawn(process.execPath, [bin, '--sunday-extension-host'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    hostProc = proc;
    proc.stdout.on('data', onHostData);
    proc.stderr.on('data', () => {});
    proc.on('error', (e) => {
      hostProc = null;
      hostReady = null;
      reject(e);
    });
    proc.on('exit', () => {
      hostProc = null;
      hostReady = null;
      for (const [, p] of pending) p.reject(new Error('extension host exited'));
      pending.clear();
    });
    const timeout = setTimeout(() => reject(new Error('extension host ping timeout')), 15000);
    extHostRpc('extHost/ping', {})
      .then(() => {
        clearTimeout(timeout);
        resolve();
      })
      .catch((e) => {
        clearTimeout(timeout);
        reject(e);
      });
  });
  return hostReady;
}

export function extHostRpc(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
  return ensureExtensionHost().then(
    () =>
      new Promise<unknown>((resolve, reject) => {
        if (!hostProc?.stdin) {
          reject(new Error('extension host not running'));
          return;
        }
        if (pending.size >= 100) {
          reject(new Error('too many pending extension-host RPCs'));
          return;
        }
        const id = rpcId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`extension host RPC timeout: ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        hostProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }),
  );
}
