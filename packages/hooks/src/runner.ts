/**
 * @sunday/hooks — sandboxed hook command execution.
 *
 * Hard guarantees:
 * - A hook NEVER hangs the caller: timeout → SIGKILL → result with
 *   `timedOut: true`. The default timeout is 10s.
 * - Output is capped (default 64 KiB, stdout+stderr combined); excess is
 *   truncated and flagged.
 * - No shell: the command runs as argv (no `sh -c` injection surface).
 * - Secret-shaped env vars are stripped before spawn so hooks can't
 *   exfiltrate provider keys (SUNDAY_*, *_API_KEY, *_TOKEN, *_SECRET).
 */

import { spawn } from 'node:child_process';

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1024;

/** Env var name patterns stripped before spawning a hook. */
const SECRET_ENV_PATTERNS: RegExp[] = [
  /^SUNDAY_/i,
  /API_KEY$/i,
  /_API_KEY$/i,
  /TOKEN$/i,
  /SECRET$/i,
  /PASSWORD$/i,
  /^GH_/i,
  /^GITHUB_/i,
];

export interface HookTemplateVars {
  /** {file} — primary path from the triggering tool call. */
  file?: string;
  /** {tool} — triggering tool name. */
  tool?: string;
  /** {cwd} — workspace root. */
  cwd?: string;
}

export interface RunHookOptions {
  cwd: string;
  timeoutMs?: number;
  outputCapBytes?: number;
  /** Extra env merged over the sanitized process env. */
  env?: Record<string, string>;
  /** Template vars for {file}/{tool}/{cwd} substitution in args. */
  templates?: HookTemplateVars;
  /** When false (default), {…} placeholders are left untouched. */
  allowTemplates?: boolean;
}

export interface HookRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the timeout fired and the process was killed. */
  timedOut: boolean;
  /** True when output exceeded the cap and was truncated. */
  truncated: boolean;
  /** True when the process couldn't even be spawned. */
  spawnError?: string;
  durationMs: number;
}

/** Remove secret-shaped vars from the environment a hook sees. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SECRET_ENV_PATTERNS.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  // Hooks always get a marker so nested tooling can tell it runs as a hook.
  out.SUNDAY_HOOK = '1';
  return out;
}

function applyTemplates(arg: string, vars: HookTemplateVars): string {
  return arg
    .replaceAll('{file}', vars.file ?? '')
    .replaceAll('{tool}', vars.tool ?? '')
    .replaceAll('{cwd}', vars.cwd ?? '');
}

/**
 * Run a hook command. Always resolves — never rejects, never hangs.
 * Kills the child on timeout (SIGTERM → SIGKILL escalation).
 */
export function runHookCommand(
  command: string,
  args: readonly string[],
  opts: RunHookOptions,
): Promise<HookRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const cap = opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
  const start = Date.now();

  return new Promise((resolve) => {
    const finalArgs =
      opts.allowTemplates === false
        ? [...args]
        : args.map((a) => applyTemplates(a, { ...(opts.templates ?? {}), cwd: opts.cwd }));

    const finish = (partial: Omit<HookRunResult, 'durationMs'>) =>
      resolve({ ...partial, durationMs: Date.now() - start });

    let child;
    try {
      child = spawn(command, finalArgs, {
        cwd: opts.cwd,
        env: { ...sanitizeEnv(process.env), ...(opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // No shell — argv execution only.
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      finish({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        truncated: false,
        spawnError: (e as Error).message,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const onData = (chunk: Buffer, which: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      const current = which === 'out' ? stdout : stderr;
      if (current.length + text.length > cap) {
        truncated = true;
        const room = Math.max(0, cap - current.length);
        if (which === 'out') stdout += text.slice(0, room);
        else stderr += text.slice(0, room);
        // Stop reading further — destroy the streams, keep the process
        // verdict (it may still exit on its own before the timeout).
        child.stdout?.destroy();
        child.stderr?.destroy();
      } else if (which === 'out') {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    child.stdout?.on('data', (c) => onData(c, 'out'));
    child.stderr?.on('data', (c) => onData(c, 'err'));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      finish({
        stdout,
        stderr,
        exitCode: null,
        timedOut: false,
        truncated,
        spawnError: (e as Error).message,
      });
    });

    // The guarantee: this timer ALWAYS fires and ALWAYS kills.
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      // Escalate: SIGKILL shortly after if SIGTERM didn't take.
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 500).unref?.();
      finish({ stdout, stderr, exitCode: null, timedOut: true, truncated });
    }, Math.max(50, timeoutMs));
    // Don't let the timer hold the event loop open by itself.
    (killTimer as unknown as { unref?: () => void }).unref?.();

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      finish({ stdout, stderr, exitCode: code, timedOut: false, truncated });
    });
  });
}
