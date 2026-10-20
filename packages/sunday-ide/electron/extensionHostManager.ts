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

/**
 * Write a line to the host's stdin, swallowing write errors. Used from
 * async callbacks where a throw would surface as an unhandled rejection;
 * if the host died mid-write its exit handler owns state cleanup.
 * (Request writes in extHostRpc stay unguarded on purpose: there a throw
 * inside the promise executor correctly rejects that RPC.)
 */
function writeToHost(line: string): void {
  try {
    hostProc?.stdin?.write(line + '\n');
  } catch {
    // host gone — exit handler cleans up
  }
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
          if (msg.id !== undefined) writeToHost(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: r }));
        },
        (e: Error) => {
          if (msg.id !== undefined)
            writeToHost(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: e.message } }));
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
  const bin = hostBin();
  if (!fs.existsSync(bin)) {
    // Checked BEFORE anything is cached: a missing bundle must not poison
    // hostReady with a forever-rejected promise, and must not consume
    // circuit-breaker budget.
    return Promise.reject(new Error(`extension host not built at ${bin}`));
  }
  spawnAttempts.push(Date.now());
  hostReady = new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, [bin, '--sunday-extension-host'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    hostProc = proc;
    proc.stdout.on('data', onHostData);
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {
      // EPIPE class: the child died mid-write. The exit/error handlers
      // below own state cleanup; an unhandled stdin 'error' would throw.
    });
    proc.on('error', (e) => {
      if (hostProc === proc) {
        hostProc = null;
        hostReady = null;
      }
      reject(e);
    });
    proc.on('exit', () => {
      const wasCurrent = hostProc === proc;
      if (wasCurrent) {
        hostProc = null;
        hostReady = null;
        for (const [, p] of pending) p.reject(new Error('extension host exited'));
        pending.clear();
      }
      // No-op once settled (e.g. a normal startup) — only rejects a
      // startup that is still waiting on its handshake.
      reject(new Error('extension host exited during startup'));
    });
    // Handshake: extHost/ping proves the host is up and speaking JSON-RPC.
    // The ping is written DIRECTLY onto the pending-RPC machinery — it must
    // NOT go through extHostRpc(): this executor runs synchronously BEFORE
    // `hostReady` is assigned, so extHostRpc → ensureExtensionHost() would
    // see hostReady === null, spawn again, and recurse until the spawn
    // circuit breaker rejected every call, leaving a rejected promise
    // cached forever and up to 3 orphaned host processes. (Exactly the bug
    // class fixed earlier in daemonClient.ts; this mirrors that fix.)
    const pingId = rpcId++;
    const failStartup = (e: Error): void => {
      // Any handshake failure: kill the spawned host and clear the cached
      // promise so a later call can retry with a fresh spawn instead of
      // inheriting this failure for the rest of the session.
      if (hostProc === proc) {
        hostProc = null;
        hostReady = null;
      }
      try {
        proc.kill();
      } catch {
        // already dead
      }
      reject(e);
    };
    const timeout = setTimeout(() => {
      pending.delete(pingId);
      failStartup(new Error('extension host ping timeout'));
    }, 15000);
    pending.set(pingId, {
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (e) => {
        clearTimeout(timeout);
        failStartup(e);
      },
    });
    try {
      proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: pingId, method: 'extHost/ping', params: {} }) + '\n',
      );
    } catch (e) {
      clearTimeout(timeout);
      pending.delete(pingId);
      failStartup(e instanceof Error ? e : new Error(String(e)));
    }
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
