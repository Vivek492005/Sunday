/**
 * Stage 4: idle shutdown for the per-user sundayd daemon.
 *
 * The daemon exits cleanly (exit 0) after `idleTimeoutMinutes` of
 * inactivity — but only when there is genuinely nothing to do:
 * zero connected clients AND zero active (in-memory) sessions. Any RPC
 * activity resets the clock via `recordActivity()`.
 *
 * Config: `sunday.daemon.idleTimeoutMinutes` (default 30; 0 = disabled),
 * stamped by the extension as `SUNDAY_DAEMON_IDLE_TIMEOUT_MINUTES` at spawn.
 * The CLI also accepts `--idle-timeout-minutes <n>` for manual runs.
 */

export const IDLE_TIMEOUT_ENV = 'SUNDAY_DAEMON_IDLE_TIMEOUT_MINUTES';

/** Default idle timeout in minutes when nothing is configured. */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;

/** How often (ms) the idle check runs. Short enough to exit promptly. */
export const IDLE_CHECK_INTERVAL_MS = 30_000;

export interface IdleShutdownOptions {
  /** Minutes of inactivity before shutdown. 0 = disabled. */
  idleTimeoutMinutes: number;
  /** Called when the daemon should shut down; receives the reason string. */
  onIdleShutdown: (reason: string) => void;
  /** Number of currently connected clients (socket peers / stdio parent). */
  getClientCount: () => number;
  /** Number of active (in-memory, un-closed) sessions. */
  getActiveSessionCount: () => number;
  /** Timer injection for tests. Defaults to the real globals. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** Clock injection for tests. Defaults to Date.now. */
  now?: () => number;
  /** Logger. Defaults to console.error (stderr keeps NDJSON clean). */
  log?: (msg: string) => void;
}

/**
 * Parse the idle timeout from an env-style record. Returns the default
 * when unset/unparseable; 0 disables. Negative values are treated as 0.
 */
export function parseIdleTimeoutMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDLE_TIMEOUT_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_TIMEOUT_MINUTES;
  return Math.floor(n);
}

/**
 * Tracks daemon activity and fires `onIdleShutdown` once the daemon has
 * been idle for the configured timeout with no clients and no sessions.
 * Idempotent: after firing once, the timer stops and never fires again.
 */
export class IdleShutdownManager {
  private lastActivityMs: number;
  private timer: NodeJS.Timeout | undefined;
  private fired = false;

  constructor(private readonly opts: IdleShutdownOptions) {
    this.lastActivityMs = (opts.now ?? Date.now)();
  }

  /** Begin the periodic idle check. No-op when disabled (timeout 0). */
  start(): void {
    if (this.opts.idleTimeoutMinutes <= 0) {
      this.opts.log?.('[sundayd] idle shutdown disabled (timeout 0)');
      return;
    }
    if (this.timer) return;
    const setIntervalFn = this.opts.setIntervalFn ?? setInterval;
    this.opts.log?.(
      `[sundayd] idle shutdown armed: ${this.opts.idleTimeoutMinutes} min, ` +
        `requires 0 clients and 0 active sessions`,
    );
    this.timer = setIntervalFn(() => this.check(), IDLE_CHECK_INTERVAL_MS);
    // Don't keep the process alive just for the idle timer.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the idle check (e.g. on graceful shutdown). */
  stop(): void {
    if (this.timer) {
      (this.opts.clearIntervalFn ?? clearInterval)(this.timer);
      this.timer = undefined;
    }
  }

  /** Record user activity — resets the idle clock. Call on every RPC. */
  recordActivity(): void {
    this.lastActivityMs = (this.opts.now ?? Date.now)();
  }

  /** Milliseconds since the last recorded activity. */
  idleMs(nowMs?: number): number {
    return (nowMs ?? (this.opts.now ?? Date.now)()) - this.lastActivityMs;
  }

  /** The single idle check. Exposed for tests; the timer calls it. */
  check(): void {
    if (this.fired || this.opts.idleTimeoutMinutes <= 0) return;
    const idleMs = this.idleMs();
    if (idleMs < this.opts.idleTimeoutMinutes * 60_000) return;
    const clients = this.opts.getClientCount();
    const sessions = this.opts.getActiveSessionCount();
    if (clients > 0 || sessions > 0) return;
    this.fired = true;
    this.stop();
    const reason =
      `idle for ${Math.round(idleMs / 60_000)} min ` +
      `(timeout ${this.opts.idleTimeoutMinutes} min, 0 clients, 0 active sessions)`;
    this.opts.log?.(`[sundayd] idle shutdown: ${reason}`);
    this.opts.onIdleShutdown(reason);
  }
}
