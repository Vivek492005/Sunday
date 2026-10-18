/**
 * Typed access to the PTY bridge (`window.sunday.pty`).
 * Each terminal tab owns a session id; the main process spawns a real
 * pseudoterminal via @lydell/node-pty and streams data back over IPC.
 */
import type { SundayAPI } from '../../electron/preload';

declare global {
  interface Window {
    sunday?: SundayAPI;
  }
}

function bridge(): SundayAPI {
  const api = window.sunday;
  if (!api) {
    throw new Error(
      'Sunday bridge unavailable — the Sunday IDE renderer must run inside the Electron shell (`pnpm dev`).',
    );
  }
  return api;
}

export interface PtyCallbacks {
  onData: (id: string, data: string) => void;
  onExit: (id: string, exitCode: number) => void;
}

/** Subscribe once per app lifetime; returns an unsubscribe function. */
export function subscribePty(cb: PtyCallbacks): () => void {
  const api = bridge();
  const offData = api.pty.onData((info) => cb.onData(info.id, info.data));
  const offExit = api.pty.onExit((info) => cb.onExit(info.id, info.exitCode));
  return () => {
    offData();
    offExit();
  };
}

export const ptyService = {
  spawn(id: string, cwd: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> {
    return bridge().pty.spawn(id, cwd, cols, rows);
  },
  write(id: string, data: string): Promise<void> {
    return bridge().pty.write(id, data);
  },
  resize(id: string, cols: number, rows: number): Promise<void> {
    return bridge().pty.resize(id, cols, rows);
  },
  kill(id: string): Promise<void> {
    return bridge().pty.kill(id);
  },
};
