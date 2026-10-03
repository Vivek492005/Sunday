/**
 * @sunday/protocol — well-known per-user daemon paths + single-flight
 * lockfile helpers (Phase 8 Stage 2).
 *
 * These are shared conventions, not wire protocol: both the extension
 * (`DaemonConnector`) and `sundayd --socket` must compute the same
 * per-user socket path and agree on the lockfile format, so they live in
 * the one package both sides already depend on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export interface DaemonSocketPathOverrides {
  platform?: NodeJS.Platform;
  username?: string;
  homeDir?: string;
}

function sanitizePipeUser(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
  return s.length > 0 ? s : 'user';
}

/**
 * Well-known per-user daemon socket path:
 * - POSIX: `~/.sunday/sundayd.sock`
 * - Windows: `\\.\pipe\sundayd-<username>` (sanitized; short by design —
 *   named-pipe paths have length limits and per-user uniqueness is what
 *   the OS ACLs give us anyway).
 */
export function sharedDaemonSocketPath(overrides: DaemonSocketPathOverrides = {}): string {
  const platform = overrides.platform ?? process.platform;
  if (platform === 'win32') {
    const username = overrides.username ?? process.env.USERNAME ?? process.env.USER ?? 'user';
    return `\\\\.\\pipe\\sundayd-${sanitizePipeUser(username)}`;
  }
  const home = overrides.homeDir ?? homedir();
  return path.join(home, '.sunday', 'sundayd.sock');
}

/**
 * Lockfile path for the single-flight spawn mutex: `~/.sunday/sundayd.lock`
 * on all platforms (plain file; the mutex is `wx` exclusive-create).
 */
export function sharedDaemonLockPath(
  overrides: Pick<DaemonSocketPathOverrides, 'homeDir' | 'platform'> = {},
): string {
  const home = overrides.homeDir ?? homedir();
  return path.join(home, '.sunday', 'sundayd.lock');
}

/** True when the socket path is the well-known per-user daemon path. */
export function isSharedDaemonSocket(socketPath: string): boolean {
  return socketPath === sharedDaemonSocketPath();
}

/** Lockfile payload. Written by the spawn winner (its own PID) and
 * overwritten by the daemon itself once it is serving. */
export interface DaemonLockInfo {
  pid: number;
  socketPath: string;
  startedAt: string;
  version: 1;
}

/** Read + validate the lockfile. Undefined when missing or malformed. */
export function readDaemonLock(lockPath: string): DaemonLockInfo | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<DaemonLockInfo>;
    if (typeof raw.pid !== 'number' || !Number.isFinite(raw.pid)) return undefined;
    return {
      pid: raw.pid,
      socketPath: typeof raw.socketPath === 'string' ? raw.socketPath : '',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      version: 1,
    };
  } catch {
    return undefined;
  }
}

/** Overwrite the lockfile (daemon use on startup). Creates parent dirs. */
export function writeDaemonLock(lockPath: string, info: DaemonLockInfo): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(info), { mode: 0o600 });
}

/**
 * Atomically claim the spawn mutex via exclusive-create (`wx`). Returns
 * true when we won; false when someone else holds it (EEXIST). Other
 * errors (e.g. missing parent dir) are thrown — the caller ensures the
 * directory exists first.
 */
export function acquireDaemonLock(lockPath: string, info: DaemonLockInfo): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(info));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Remove the lockfile, but only when it still names our PID — never delete
 * a successor's lock (e.g. a new daemon that started after a crash).
 */
export function releaseDaemonLockIfOurs(lockPath: string, pid: number): void {
  try {
    if (readDaemonLock(lockPath)?.pid === pid) fs.unlinkSync(lockPath);
  } catch {
    /* best-effort */
  }
}

/**
 * Best-effort process liveness check. `kill(pid, 0)` throws ESRCH when the
 * PID is gone and EPERM when it exists but is not signalable (both POSIX
 * and Windows via libuv).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
