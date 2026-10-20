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

/** Generic daemon-notification handlers, keyed by JSON-RPC method name. */
export type NotificationHandler = (params: unknown) => void;
const notificationHandlers = new Map<string, Set<NotificationHandler>>();

export function addNotificationHandler(method: string, h: NotificationHandler): void {
  let set = notificationHandlers.get(method);
  if (!set) {
    set = new Set();
    notificationHandlers.set(method, set);
  }
  set.add(h);
}

export function removeNotificationHandler(method: string, h: NotificationHandler): void {
  notificationHandlers.get(method)?.delete(h);
}

function dispatchDaemonNotification(method: string, params: unknown): void {
  if (method === 'chat/event') {
    const p = params as {
      event?: { type: string; [k: string]: unknown };
      turnId?: string;
      sessionId?: string;
      via?: string;
      relay?: unknown;
    };
    const ev = p.event;
    if (ev) {
      // Merge the envelope ids into the delivered event: handlers (e.g.
      // agentBackend.realAgentSend) correlate by turnId, and the daemon puts
      // turnId/sessionId on the NOTIFICATION, not inside the event itself.
      // Without this merge every handler's turnId filter drops all events.
      const merged = {
        ...ev,
        ...(p.turnId ? { turnId: p.turnId } : {}),
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(p.via ? { via: p.via } : {}),
        ...(p.relay ? { relay: p.relay } : {}),
      };
      for (const h of chatEventHandlers) h(merged);
    }
  }
  const generic = notificationHandlers.get(method);
  if (generic) for (const h of generic) h(params);
}

function onDaemonData(chunk: Buffer): void {
  rpcBuffer += chunk.toString('utf8');
  let nl: number;
  while ((nl = rpcBuffer.indexOf('\n')) >= 0) {
    const line = rpcBuffer.slice(0, nl).trim();
    rpcBuffer = rpcBuffer.slice(nl + 1);
    if (!line) continue;
    try {
      // parseMessage returns a { kind, message } WRAPPER — the payload
      // fields live on .message. (Reading them off the wrapper directly
      // silently dropped every response and notification.)
      const parsed = parseMessage(line);
      if (parsed.kind === 'response') {
        const msg = parsed.message as {
          id?: number | string;
          result?: unknown;
          error?: { message?: string };
        };
        if (msg.id !== undefined) {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? 'daemon RPC error'));
            else p.resolve(msg.result);
          }
        }
      } else if (parsed.kind === 'notification') {
        const msg = parsed.message as { method?: string; params?: unknown };
        dispatchDaemonNotification(msg.method ?? '', msg.params);
      }
    } catch {
      // Non-JSONRPC line (daemon logs go to stderr; ignore stdout noise)
    }
  }
}

let daemonSpawnAttempts: number[] = [];

/**
 * Circuit breaker: if the daemon keeps dying on startup, don't respawn in a
 * hot loop (each spawn is a full Electron process). Max 3 attempts per 60s;
 * after that fail fast until the window slides past.
 */
function daemonSpawnAllowed(): boolean {
  const now = Date.now();
  daemonSpawnAttempts = daemonSpawnAttempts.filter((t) => now - t < 60_000);
  return daemonSpawnAttempts.length < 3;
}

function ensureDaemon(): Promise<void> {
  if (daemonReady) return daemonReady;
  if (!daemonSpawnAllowed()) {
    return Promise.reject(
      new Error('sundayd failed to start repeatedly — giving up for now (circuit breaker). Restart Sunday to retry.'),
    );
  }
  daemonSpawnAttempts.push(Date.now());
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
    // The ping is written DIRECTLY onto the pending-RPC machinery — it must
    // NOT go through daemonRpc(): this executor runs synchronously BEFORE
    // `daemonReady` is assigned, so daemonRpc → ensureDaemon() would see
    // daemonReady === null, spawn again, and recurse until the spawn
    // circuit breaker rejected every daemon call (the daemon was
    // unreachable from the IDE because of exactly that).
    const pingId = rpcId++;
    const timeout = setTimeout(() => {
      pending.delete(pingId);
      reject(new Error('daemon ping timeout'));
    }, 15000);
    pending.set(pingId, {
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    });
    try {
      proc.stdin.write(JSON.stringify(createRequest(pingId, 'sunday/ping', {})) + '\n');
    } catch (e) {
      clearTimeout(timeout);
      pending.delete(pingId);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
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
        // SAFETY: cap in-flight RPCs — an unresponsive daemon must not let
        // the pending map (and its timers) grow without bound.
        if (pending.size >= 100) {
          reject(new Error('too many pending daemon RPCs — daemon overloaded'));
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
