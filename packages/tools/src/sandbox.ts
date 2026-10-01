// @sunday/tools — sandbox execution for agent-run shell commands.
//
// `run_terminal` executes on the host by default. When the caller stamps a
// `SandboxConfig` with mode 'docker' or 'bubblewrap' on the ToolContext,
// the command runs inside a disposable sandbox instead. No new npm
// dependencies: we shell out to the `docker` / `bwrap` CLIs.
//
// This module also hosts the shared spawn+collect machinery (`runCommand`,
// `killTree`) used by both the host and the sandboxed execution paths.

import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { err, type ToolResult } from './types.js';

/** Sandbox execution modes. 'off' = current behavior (host execution). */
export type SandboxMode = 'off' | 'docker' | 'bubblewrap';

export const SANDBOX_MODES: readonly SandboxMode[] = ['off', 'docker', 'bubblewrap'];

/** Small documented default image for docker mode. Users running real
 *  builds should point `sunday.sandbox.dockerImage` at something with a
 *  toolchain (e.g. `node:22-alpine`). */
export const DEFAULT_DOCKER_IMAGE = 'alpine:latest';

/** In-sandbox working directory the workspace is mounted at. */
export const SANDBOX_WORKDIR = '/work';

export interface SandboxConfig {
  mode: SandboxMode;
  /** Container image for docker mode (default: DEFAULT_DOCKER_IMAGE). */
  dockerImage: string;
}

export const SANDBOX_OFF: SandboxConfig = { mode: 'off', dockerImage: DEFAULT_DOCKER_IMAGE };

// ---------------------------------------------------------------------------
// Shared spawn machinery (moved here from terminal.ts so both the host path
// and the sandboxed path reuse the same timeout/abort/output-cap semantics).
// ---------------------------------------------------------------------------

/** Kill the whole process tree. Plain child.kill() (SIGTERM) is not enough:
 *  shells like bash defer SIGTERM while waiting for a foreground child, so a
 *  timed-out `sleep 30` would linger for the full duration. SIGKILL cannot be
 *  deferred; on POSIX we target the process group so grandchildren die too. */
export function killTree(child: ChildProcess): void {
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

export function runCommand(
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

// ---------------------------------------------------------------------------
// Availability detection
// ---------------------------------------------------------------------------

/** Probe for a sandbox binary. Injected in tests; production uses `--version`. */
export type SandboxProbe = (binary: string) => boolean;

let probeForTests: SandboxProbe | undefined;
/** Test seam: override the availability probe for the process lifetime. */
export function setSandboxProbeForTests(probe: SandboxProbe | undefined): void {
  probeForTests = probe;
  availabilityCache.clear();
}

export function defaultSandboxProbe(binary: string): boolean {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const availabilityCache = new Map<SandboxMode, { ok: boolean; reason?: string }>();
/** Test seam: drop cached availability results. */
export function clearSandboxAvailabilityCache(): void {
  availabilityCache.clear();
}

export interface SandboxAvailability {
  ok: boolean;
  /** Human-readable reason when !ok — doubles as the user-facing error. */
  reason?: string;
}

export function checkSandboxAvailable(
  mode: SandboxMode,
  opts: { probe?: SandboxProbe; platform?: NodeJS.Platform } = {},
): SandboxAvailability {
  const platform = opts.platform ?? process.platform;
  const cached = availabilityCache.get(mode);
  if (cached && !opts.probe) return cached;
  const probe = opts.probe ?? probeForTests ?? defaultSandboxProbe;
  let result: SandboxAvailability;
  if (mode === 'off') {
    result = { ok: true };
  } else if (mode === 'docker') {
    result = probe('docker')
      ? { ok: true }
      : {
          ok: false,
          reason:
            'sandbox mode "docker" is enabled but the docker CLI was not found. ' +
            'Install Docker Desktop (https://docs.docker.com/get-docker/), make sure ' +
            "`docker` is on PATH, then restart sundayd — or set sunday.sandbox.mode back to \"off\".",
        };
  } else {
    // bubblewrap
    if (platform !== 'linux') {
      result = {
        ok: false,
        reason:
          `sandbox mode "bubblewrap" is only supported on Linux (this host is ${platform}). ` +
            'Use "docker" or "off" instead.',
      };
    } else {
      result = probe('bwrap')
        ? { ok: true }
        : {
            ok: false,
            reason:
              'sandbox mode "bubblewrap" is enabled but `bwrap` was not found. ' +
                "Install bubblewrap (e.g. `sudo apt install bubblewrap` on Debian/Ubuntu), " +
                'then restart sundayd — or set sunday.sandbox.mode back to "off".',
          };
    }
  }
  if (!opts.probe) availabilityCache.set(mode, result);
  return result;
}

// ---------------------------------------------------------------------------
// Command construction (pure — unit-tested without docker/bwrap installed)
// ---------------------------------------------------------------------------

export interface BuiltSandboxCommand {
  cmd: string;
  argv: string[];
  /** docker only: the --name given to the container (for cleanup). */
  containerName?: string;
}

let containerCounter = 0;

/** docker run --rm -i --network none -v <workspace>:/work -w /work <image> sh -c <cmd>
 *  `--pull never`: a missing image fails fast with a clear error instead of
 *  implicitly pulling over the network (network stays off in v1). */
export function buildDockerCommand(
  command: string,
  workspace: string,
  image: string,
  containerName = `sunday-sandbox-${process.pid}-${++containerCounter}`,
): BuiltSandboxCommand {
  return {
    cmd: 'docker',
    argv: [
      'run',
      '--rm',
      '-i',
      '--name',
      containerName,
      '--pull',
      'never',
      '--network',
      'none',
      '-v',
      `${workspace}:${SANDBOX_WORKDIR}`,
      '-w',
      SANDBOX_WORKDIR,
      image,
      'sh',
      '-c',
      command,
    ],
    containerName,
  };
}

/** bwrap with an unshared network namespace, the host root mounted
 *  read-only, and only the workspace writable. `--dir /work` must precede
 *  `--bind` (bwrap does not create the mountpoint itself). */
export function buildBwrapCommand(command: string, workspace: string): BuiltSandboxCommand {
  return {
    cmd: 'bwrap',
    argv: [
      '--unshare-net',
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp',
      '--dir',
      SANDBOX_WORKDIR,
      '--bind',
      workspace,
      SANDBOX_WORKDIR,
      '--chdir',
      SANDBOX_WORKDIR,
      'sh',
      '-c',
      command,
    ],
  };
}

// ---------------------------------------------------------------------------
// Sandboxed execution
// ---------------------------------------------------------------------------

export interface RunSandboxedOptions {
  command: string;
  sandbox: SandboxConfig;
  /** Host workspace directory (resolved to absolute). */
  cwd: string;
  timeoutMs: number;
  maxOut: number;
  signal?: AbortSignal;
  /** Test seams (not set by production callers). */
  probe?: SandboxProbe;
  runner?: typeof runCommand;
}

/** Best-effort `docker kill` so a timed-out/aborted `docker run --rm` does
 *  not leave the container running after we SIGKILL the CLI. */
function dockerKillBestEffort(containerName: string): void {
  try {
    const killer = spawn('docker', ['kill', containerName], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => undefined);
  } catch {
    /* docker itself missing — nothing to clean up */
  }
}

export async function runSandboxed(opts: RunSandboxedOptions): Promise<ToolResult> {
  const { mode } = opts.sandbox;
  if (mode === 'off') {
    return err('internal error: runSandboxed called with sandbox mode "off"');
  }
  const avail = checkSandboxAvailable(mode, { probe: opts.probe });
  if (!avail.ok) return err(avail.reason ?? `sandbox mode "${mode}" is not available`);
  if (mode === 'docker' && !opts.sandbox.dockerImage.trim()) {
    return err(
      'sandbox mode "docker" needs an image: set sunday.sandbox.dockerImage ' +
        `(env ${'SUNDAY_SANDBOX_DOCKER_IMAGE'}) to a locally available image.`,
    );
  }
  const workspace = resolve(opts.cwd);
  const built =
    mode === 'docker'
      ? buildDockerCommand(opts.command, workspace, opts.sandbox.dockerImage.trim())
      : buildBwrapCommand(opts.command, workspace);

  // If the agent's turn is cancelled (or the timeout fires) while docker is
  // running, the CLI is SIGKILLed but the container would survive `--rm` —
  // kill it explicitly. bwrap dies with its parent (--die-with-parent).
  let onAbort: (() => void) | undefined;
  if (built.containerName) {
    const name = built.containerName;
    onAbort = () => dockerKillBestEffort(name);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const runner = opts.runner ?? runCommand;
    const result = await runner(built.cmd, built.argv, workspace, opts.timeoutMs, opts.maxOut, opts.signal);
    let output = result.output;
    if (mode === 'docker' && result.isError && result.metadata?.exitCode === 125) {
      output +=
        `\n\n[docker run failed — if the image '${opts.sandbox.dockerImage.trim()}' is missing locally, ` +
        `pull it once on the host with \`docker pull ${opts.sandbox.dockerImage.trim()}\` and retry.]`;
    }
    if (result.metadata?.timedOut && built.containerName) {
      dockerKillBestEffort(built.containerName);
    }
    return {
      ...result,
      output,
      metadata: { ...result.metadata, sandbox: mode },
    };
  } finally {
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
}
