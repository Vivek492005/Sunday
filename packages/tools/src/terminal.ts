import fs from 'node:fs/promises';
import { resolveWithinRoot } from './paths.js';
import { runCommand, runSandboxed } from './sandbox.js';
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
        // $OutputEncoding (not [Console]::OutputEncoding): sets the encoding
        // for PIPED output. [Console]::OutputEncoding touches the interactive
        // console, which doesn't exist under CI pipes and can hang the shell
        // on exit in Windows PowerShell 5.1.
        `$OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`,
      ],
    };
  }
  return { cmd: 'sh', argv: (command) => ['-c', command] };
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
    const maxOut = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    // Hardening: the single sandbox decision point. Every agent shell command
    // flows through here; ctx.sandbox is stamped by sundayd from
    // `sunday.sandbox.*` (default mode 'off' = host execution, unchanged).
    if (ctx.sandbox && ctx.sandbox.mode !== 'off') {
      return runSandboxed({
        command: args.command,
        sandbox: ctx.sandbox,
        cwd: workdir,
        timeoutMs,
        maxOut,
        signal: ctx.signal,
      });
    }
    const { cmd, argv } = shellForPlatform();
    return runCommand(cmd, argv(args.command), workdir, timeoutMs, maxOut, ctx.signal);
  },
};
