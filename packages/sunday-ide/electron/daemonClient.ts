/**
 * Sunday IDE — daemonClient.ts
 *
 * Lightweight JSON-RPC client for the sundayd daemon (spawned over stdio).
 *
 * Extracted from agentBackend.ts so that modules needing ONLY the daemon RPC
 * (e.g. opsBackend.ts) don't pull the entire agent backend dependency graph
 * (ext-agent, @sunday/context, @sunday/orchestrator, ...) into their import
 * chain. That chain OOM-kills vitest on memory-constrained machines.
 *
 * Only dependency: @sunday/protocol (message parsing — tiny).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseMessage, createRequest } from '@sunday/protocol';

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

let daemonProc: ChildProcess | null = null;
let daemonReady: Promise<void> | null = null;
let rpcId = 1;
const pending = new Map<number | string, PendingRpc>();
let rpcBuffer = '';

function daemonBin(): string {
  // 1. Packaged app: dist-electron/sundayd.cjs (bundled by build-electron.mjs).
  const bundled = path.resolve(__dirname, 'sundayd.cjs');
  if (fs.existsSync(bundled)) return bundled;
  // 2. Dev: packages/sundayd/dist/cli.js
  // packages/sunday-ide/electron -> packages/sundayd/dist/cli.js
  return path.resolve(__dirname, '..', '..', 'sundayd', 'dist', 'cli.js');
}

export type ChatEventHandler = (event: { type: string; [k: string]: unknown }) => void;
const chatEventHandlers = new Set<ChatEventHandler>();

export function addChatEventHandler(h: ChatEventHandler): void {
  chatEventHandlers.add(h);
}

export function removeChatEventHandler(h: ChatEventHandler): void {
  chatEventHandlers.delete(h);
}

function dispatchDaemonNotification(method: string, params: unknown): void {
  if (method === 'chat/event') {
    const p = params as { event?: { type: string; [k: string]: unknown } };
    const ev = p.event;
    if (ev) for (const h of chatEventHandlers) h(ev);
  }
}

function onDaemonData(chunk: Buffer): void {
  rpcBuffer += chunk.toString('utf8');
  let nl: number;
  while ((nl = rpcBuffer.indexOf('\n')) >= 0) {
    const line = rpcBuffer.slice(0, nl).trim();
    rpcBuffer = rpcBuffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = parseMessage(line) as unknown as {
        kind: string;
        id?: number | string;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: unknown;
      };
      if (msg.kind === 'response' && msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? 'daemon RPC error'));
          else p.resolve(msg.result);
        }
      } else if (msg.kind === 'notification') {
        dispatchDaemonNotification(msg.method ?? '', msg.params);
      }
    } catch {
      // Non-JSONRPC line (daemon logs go to stderr; ignore stdout noise)
    }
  }
}

function ensureDaemon(): Promise<void> {
  if (daemonReady) return daemonReady;
  daemonReady = new Promise<void>((resolve, reject) => {
    const bin = daemonBin();
    if (!fs.existsSync(bin)) {
      reject(new Error(`sundayd not built at ${bin} — run pnpm --filter @sunday/sundayd build`));
      return;
    }
    // Spawn via the Electron binary with --sundayd-daemon: main.ts detects the
    // flag and runs the daemon bundle instead of creating IDE windows.
    // (Never spawn the binary WITHOUT the flag — that would launch another
    // full IDE, which spawns another, infinitely: the 100+ windows bug.)
    const proc = spawn(process.execPath, [bin, '--sundayd-daemon'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    daemonProc = proc;
    proc.stdout.on('data', onDaemonData);
    proc.stderr.on('data', () => {
      // Daemon logs go to stderr; ignore in normal operation
    });
    proc.on('error', (e) => {
      daemonProc = null;
      daemonReady = null;
      reject(e);
    });
    proc.on('exit', () => {
      daemonProc = null;
      daemonReady = null;
      for (const [, p] of pending) p.reject(new Error('daemon exited'));
      pending.clear();
    });
    // Handshake: sunday/ping proves the daemon is up and speaking JSON-RPC.
    const timeout = setTimeout(() => reject(new Error('daemon ping timeout')), 15000);
    daemonRpc('sunday/ping', {})
      .then(() => {
        clearTimeout(timeout);
        resolve();
      })
      .catch((e) => {
        clearTimeout(timeout);
        reject(e);
      });
  });
  return daemonReady;
}

/** Raw JSON-RPC call to the sundayd daemon. Rejects honestly when the daemon is down. */
export function daemonRpc(method: string, params: unknown, timeoutMs = 60000): Promise<unknown> {
  // Test hook: simulate "daemon unavailable" without spawning anything.
  // (The test asserts the honest-unavailable shape, not daemon behavior.)
  if (process.env.SUNDAY_DAEMON_UNAVAILABLE === '1') {
    return Promise.reject(new Error('daemon unavailable (SUNDAY_DAEMON_UNAVAILABLE=1)'));
  }
  return ensureDaemon().then(
    () =>
      new Promise<unknown>((resolve, reject) => {
        if (!daemonProc?.stdin) {
          reject(new Error('daemon not running'));
          return;
        }
        const id = rpcId++;
        pending.set(id, { resolve, reject });
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`daemon RPC timeout: ${method}`));
        }, timeoutMs);
        const origResolve = resolve;
        const origReject = reject;
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            origResolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            origReject(e);
          },
        });
        daemonProc.stdin.write(JSON.stringify(createRequest(id, method, params)) + '\n');
      }),
  );
}
