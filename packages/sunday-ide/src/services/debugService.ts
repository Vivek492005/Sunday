/**
 * Sunday debug service — Wave 3 minimal scope: breakpoints + launch + stop.
 *
 * Breakpoints live here (file → set of 1-based line numbers) with a tiny
 * subscriber model so EditorArea can paint gutter decorations. Launch/stop
 * go through the main process (`node <program> <args>`), whose stdout/stderr
 * stream back over `sunday:debug-output`.
 *
 * Full DAP (step over/into, variables, call stack via vscode-debugprotocol
 * + a debug adapter) is an explicit follow-up — see the TODO in
 * electron/main.ts.
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

export interface DebugOutput {
  stream: 'stdout' | 'stderr';
  text: string;
}

type BreakpointListener = () => void;

const breakpoints = new Map<string, Set<number>>();
const listeners = new Set<BreakpointListener>();

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function emit(): void {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      // listener fault — never break the service
    }
  });
}

export function toggleBreakpoint(filePath: string, line: number): boolean {
  const key = normalize(filePath);
  let set = breakpoints.get(key);
  if (!set) {
    set = new Set<number>();
    breakpoints.set(key, set);
  }
  const nowOn = !set.has(line);
  if (nowOn) set.add(line);
  else {
    set.delete(line);
    if (set.size === 0) breakpoints.delete(key);
  }
  emit();
  return nowOn;
}

export function getBreakpoints(filePath: string): number[] {
  const set = breakpoints.get(normalize(filePath));
  return set ? [...set].sort((a, b) => a - b) : [];
}

export function getAllBreakpoints(): { filePath: string; lines: number[] }[] {
  return [...breakpoints.entries()]
    .map(([filePath, set]) => ({ filePath, lines: [...set].sort((a, b) => a - b) }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

export function clearBreakpoints(filePath?: string): void {
  if (filePath) breakpoints.delete(normalize(filePath));
  else breakpoints.clear();
  emit();
}

export function onBreakpointsChanged(cb: BreakpointListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const debugService = {
  launch(cwd: string, program: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
    return bridge().debug.launch(cwd, program, args);
  },
  stop(): Promise<void> {
    return bridge().debug.stop();
  },
  onOutput(cb: (info: DebugOutput) => void): () => void {
    try {
      return bridge().debug.onOutput(cb);
    } catch {
      return () => undefined;
    }
  },
  onExit(cb: (info: { exitCode: number; error?: string }) => void): () => void {
    try {
      return bridge().debug.onExit(cb);
    } catch {
      return () => undefined;
    }
  },
};
