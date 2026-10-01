import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { resolveWithinRoot } from './paths.js';
import { err, type Tool, type ToolContext, type ToolResult } from './types.js';

/** Terminal proxy (§7.4). PowerShell-aware: on Windows commands run under
 *  powershell.exe -NoProfile (UTF-8 output); elsewhere under sh.
 *  Output is capped, runs are bounded by a timeout, and ctx.signal aborts. */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;

function shellForPlatform(): { cmd: string; argv: (command: string) => string[] } {
  if (process.platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      argv: (command) => [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`,
      ],
    };
  }
  return { cmd: 'sh', argv: (command) => ['-c', command] };
}

/** Kill the whole process tree. Plain child.kill() (SIGTERM) is not enough:
 *  shells like bash defer SIGTERM while waiting for a foreground child, so a
 *  timed-out `sleep 30` would linger for the full duration. SIGKILL cannot be
 *  deferred; on POSIX we target the process group so grandchildren die too. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
    return;
  }
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => undefined);
    } else {
      process.kill(-pid, 'SIGKILL'); // negative pid = process group
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

function runCommand(
  cmd: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxOut: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    // detached (POSIX): child becomes a process-group leader so killTree can
    // reap grandchildren (e.g. a dev server) along with the shell.
    const child = spawn(cmd, argv, { cwd, windowsHide: true, detached: process.platform !== 'win32' });
    let out = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const push = (chunk: Buffer) => {
      if (out.length >= maxOut) {
        truncated = true;
        return;
      }
      const room = maxOut - out.length;
      out = Buffer.concat([out, chunk.subarray(0, room)]);
      if (chunk.length > room) truncated = true;
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (result: ToolResult) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.on('error', (e) =>
      done(err(`failed to start ${cmd}: ${(e as Error).message}`)),
    );
    child.on('close', (code) => {
      const text = out.toString('utf8');
      const tail = truncated ? `\n…[truncated to ${maxOut} bytes]` : '';
      const output = (text + tail).trim() || (timedOut ? '(no output before timeout)' : '(no output)');
      done({
        output,
        isError: timedOut || code !== 0,
        metadata: { exitCode: code, timedOut, truncated },
      });
    });
  });
}

export const runTerminalTool: Tool = {
  definition: {
    name: 'run_terminal',
    description:
      'Run a shell command: PowerShell on Windows, sh elsewhere. Use for builds, tests, scripts. Prefer dedicated file tools for reading/writing files.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Working directory, relative to workspace root (default ".").' },
        timeoutMs: {
          type: 'integer',
          description: 'Kill the command after this many ms.',
          minimum: 100,
          maximum: MAX_TIMEOUT_MS,
        },
        maxOutputBytes: {
          type: 'integer',
          description: 'Truncate combined stdout+stderr beyond this size.',
          minimum: 1000,
        },
      },
    },
  },
  async execute(rawArgs, ctx: ToolContext) {
    const args = rawArgs as { command: string; cwd?: string; timeoutMs?: number; maxOutputBytes?: number };
    const workdir = resolveWithinRoot(ctx.cwd, args.cwd ?? '.');
    const st = await fs.stat(workdir).catch(() => null);
    if (!st?.isDirectory()) return err(`cwd is not a directory: ${args.cwd ?? '.'}`);
    const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const { cmd, argv } = shellForPlatform();
    return runCommand(cmd, argv(args.command), workdir, timeoutMs, args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, ctx.signal);
  },
};
